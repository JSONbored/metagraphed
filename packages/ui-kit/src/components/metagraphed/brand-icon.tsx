import { useMemo, useState, useEffect, useCallback } from "react";
import { classNames } from "@/lib/format";
import { useTheme, type ResolvedTheme } from "@/lib/theme";
import {
  resolveBrandOverride,
  buildProxyIconUrl,
  pickIconSource,
  ICON_PROXY_URL,
  type BrandOverrideLookup,
  type IconSource,
} from "./brand-overrides";

/** A candidate served by our own icon proxy (CORS-enabled; trust its sizing). */
function isProxiedIcon(candidate?: string | null): boolean {
  return Boolean(
    candidate && ICON_PROXY_URL && candidate.startsWith(ICON_PROXY_URL),
  );
}

/**
 * Multi-source favicon resolution with low-resolution rejection and
 * theme-aware sourcing + auto-contrast tile.
 *
 * See `brand-overrides.ts` for the full resolution priority chain and the
 * documented icon-proxy contract.
 */

const failedUrls = new Set<string>();
const loadedUrls = new Set<string>();
const prefetched = new Set<string>();
const winnerByHost = new Map<string, string>();
/** Cached "is this logo dark-on-light?" decision per source URL. */
const isDarkLogo = new Map<string, boolean>();

function extractHost(input?: string | null): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

function githubOrgFromUrl(input?: string | null): string | null {
  if (!input) return null;
  try {
    const u = new URL(input.includes("://") ? input : `https://${input}`);
    // Exact host or a real github.com subdomain — `endsWith("github.com")` alone
    // would also accept an attacker host like "evilgithub.com".
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && !host.endsWith(".github.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] ?? null;
  } catch {
    return null;
  }
}

function githubAvatarUrl(org: string, size = 192): string {
  return `https://github.com/${encodeURIComponent(org)}.png?size=${size}`;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function normaliseImageHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((v) => v === null)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a! >= 224
  );
}

function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  return (
    hostname === "" ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb") ||
    hostname.startsWith("ff") ||
    hostname.startsWith("::ffff:")
  );
}

/**
 * Validate untrusted image sources before they reach <img src>. Registry /
 * provider metadata is attacker-controllable, so every candidate in the
 * resolution chain must be a public http(s) URL — no localhost, .local,
 * private/reserved IPv4, or IPv6 ULA/link-local/loopback/mapped targets.
 */
function safeImageUrl(input?: string | null): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    if (parsed.username || parsed.password) return null;
    const hostname = normaliseImageHostname(parsed.hostname);
    if (!hostname) return null;
    if (LOCAL_HOSTNAMES.has(hostname)) return null;
    if (hostname.endsWith(".localhost") || hostname.endsWith(".local"))
      return null;
    if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

interface ChainInputs {
  url?: string | null;
  iconUrl?: IconSource | null;
  repoUrl?: string | null;
  lookup?: BrandOverrideLookup;
  theme: ResolvedTheme;
  size: number;
}

function isDirectIconUrlCandidate(
  candidate: string | null | undefined,
  iconUrl: IconSource | null | undefined,
  theme: ResolvedTheme,
): boolean {
  if (!candidate) return false;
  const directIcon = safeImageUrl(pickIconSource(iconUrl, theme));
  return Boolean(
    directIcon && candidate === directIcon && !isProxiedIcon(candidate),
  );
}

function shouldUseAnonymousCors(
  candidate: string | null | undefined,
  iconUrl: IconSource | null | undefined,
  theme: ResolvedTheme,
): boolean {
  return (
    isProxiedIcon(candidate) ||
    isDirectIconUrlCandidate(candidate, iconUrl, theme)
  );
}

function buildCandidateChain({
  url,
  iconUrl,
  repoUrl,
  lookup,
  theme,
  size,
}: ChainInputs): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    const safe = safeImageUrl(u);
    if (!safe) return;
    if (failedUrls.has(safe)) return;
    if (!out.includes(safe)) out.push(safe);
  };

  push(pickIconSource(iconUrl, theme));
  if (lookup) push(resolveBrandOverride(lookup, theme));

  const host = extractHost(url);
  if (host) push(buildProxyIconUrl(host, size * 2, theme));

  const repoOrg = githubOrgFromUrl(repoUrl);
  if (repoOrg) push(githubAvatarUrl(repoOrg, 192));

  return out;
}

/**
 * Warm the favicon cache for items in or near the viewport. Coalesces
 * duplicate prefetches and respects the module-level success/failure caches.
 */
export function prefetchBrandIcon(
  url?: string | null,
  size = 32,
  extra?: {
    iconUrl?: IconSource | null;
    repoUrl?: string | null;
    lookup?: BrandOverrideLookup;
    theme?: ResolvedTheme;
  },
): void {
  if (typeof window === "undefined") return;
  const chain = buildCandidateChain({
    url,
    iconUrl: extra?.iconUrl,
    repoUrl: extra?.repoUrl,
    lookup: extra?.lookup,
    theme: extra?.theme ?? "light",
    size,
  });
  const first = chain[0];
  if (!first) return;
  if (prefetched.has(first) || failedUrls.has(first) || loadedUrls.has(first))
    return;
  prefetched.add(first);
  try {
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    if (
      shouldUseAnonymousCors(first, extra?.iconUrl, extra?.theme ?? "light")
    ) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => loadedUrls.add(first);
    img.onerror = () => failedUrls.add(first);
    img.src = first;
  } catch {
    /* ignore */
  }
}

function monogramFor(
  name?: string | null,
  fallback?: string | number | null,
): string {
  const source = typeof name === "string" ? name.trim() : "";
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  if (fallback !== undefined && fallback !== null) {
    return String(fallback).slice(0, 2).toUpperCase();
  }
  return "··";
}

/**
 * Sample the average alpha-weighted luminance of an image. Returns null when
 * the canvas is tainted (cross-origin without CORS) or the draw fails.
 *
 * Heuristic threshold: luminance < 0.55 → "logo is dark-on-light" and we'll
 * place it on a white tile in dark mode for legibility.
 */
function analyseLogoLuminance(img: HTMLImageElement): number | null {
  try {
    const w = 16;
    const h = 16;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let weighted = 0;
    let totalAlpha = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]! / 255;
      if (a < 0.05) continue;
      // Rec. 709 luma, normalised to 0..1.
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      weighted += luma * a;
      totalAlpha += a;
    }
    if (totalAlpha === 0) return null;
    return weighted / totalAlpha;
  } catch {
    return null;
  }
}

export interface BrandIconProps {
  url?: string | null;
  iconUrl?: IconSource | null;
  repoUrl?: string | null;
  name?: string | null;
  fallback?: string | number | null;
  size?: number;
  className?: string;
  decorative?: boolean;
  providerSlug?: string | null;
  subnetSlug?: string | null;
  netuid?: number | string | null;
}

export function BrandIcon({
  url,
  iconUrl,
  repoUrl,
  name,
  fallback,
  size = 32,
  className,
  decorative = true,
  providerSlug,
  subnetSlug,
  netuid,
}: BrandIconProps) {
  const { resolved: theme } = useTheme();
  const host = useMemo(() => extractHost(url), [url]);

  const lookup = useMemo<BrandOverrideLookup>(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid],
  );

  const chain = useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup, theme, size }),
    [url, iconUrl, repoUrl, lookup, theme, size],
  );

  // Start from the cached winner for this host, if any.
  const initialIndex = useMemo(() => {
    if (!host) return 0;
    const winner = winnerByHost.get(host);
    if (!winner) return 0;
    const idx = chain.indexOf(winner);
    return idx >= 0 ? idx : 0;
  }, [host, chain]);

  const [index, setIndex] = useState(initialIndex);
  const [loaded, setLoaded] = useState(false);
  const [needsContrastTile, setNeedsContrastTile] = useState(false);

  useEffect(() => {
    setIndex(initialIndex);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, [initialIndex, chain]);

  const candidate = chain[index] ?? null;
  const exhausted = !candidate;

  useEffect(() => {
    if (candidate && loadedUrls.has(candidate)) setLoaded(true);
    if (candidate && isDarkLogo.has(candidate)) {
      setNeedsContrastTile(theme === "dark" && isDarkLogo.get(candidate)!);
    }
  }, [candidate, theme]);

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, []);

  const onImgError = useCallback(() => {
    if (candidate) failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);

  const onImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      // Proxied favicons are the best available source for a host and are often
      // 32-64px — a real favicon beats a monogram, so only reject genuinely tiny
      // (broken) images for those. Direct sources keep the stricter hi-res bar.
      const min = isProxiedIcon(candidate)
        ? 16
        : Math.max(16, Math.floor(size * 0.9));
      if (img.naturalWidth > 0 && img.naturalWidth < min) {
        if (candidate) failedUrls.add(candidate);
        advance();
        return;
      }
      if (candidate) {
        loadedUrls.add(candidate);
        if (host) winnerByHost.set(host, candidate);

        // Luminance check (once per source URL). Skipped on cross-origin
        // images without CORS — drawImage taints the canvas and we silently
        // fall back to the default surface.
        if (!isDarkLogo.has(candidate)) {
          const luma = analyseLogoLuminance(img);
          if (luma !== null) isDarkLogo.set(candidate, luma < 0.55);
        }
        const isDark = isDarkLogo.get(candidate);
        setNeedsContrastTile(theme === "dark" && isDark === true);
      }
      setLoaded(true);
    },
    [candidate, advance, host, size, theme],
  );

  const baseClasses = classNames(
    "relative inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded-md border border-border",
    needsContrastTile ? "bg-white/95" : "bg-surface",
    className,
  );
  const style = { width: size, height: size };
  const labelText = name ?? (fallback != null ? String(fallback) : "");
  const ariaLabel = decorative
    ? undefined
    : labelText
      ? `${labelText} icon`
      : "icon";
  const ariaHidden = decorative ? true : undefined;

  if (exhausted) {
    return (
      <span
        className={classNames(baseClasses, "bg-accent/10 text-ink-strong")}
        style={style}
        role={decorative ? undefined : "img"}
        aria-hidden={ariaHidden}
        aria-label={ariaLabel}
        title={decorative ? undefined : labelText || undefined}
      >
        <span
          className="font-display font-semibold tabular-nums leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
          aria-hidden="true"
        >
          {monogramFor(name, fallback)}
        </span>
      </span>
    );
  }

  return (
    <span
      className={baseClasses}
      style={style}
      role={decorative ? undefined : "img"}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      title={decorative ? undefined : labelText || undefined}
    >
      {!loaded ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 flex items-center justify-center bg-accent/10 text-ink-muted/70"
        >
          <span
            className="font-display font-semibold tabular-nums leading-none"
            style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
          >
            {monogramFor(name, fallback)}
          </span>
        </span>
      ) : null}
      <img
        key={candidate ?? "x"}
        src={candidate!}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        // Request credentialless CORS for our proxy and direct registry/API icon_url
        // values. Curated frontend overrides and GitHub fallbacks can still load as
        // ordinary images so missing CORS headers do not hide trusted icons.
        crossOrigin={
          shouldUseAnonymousCors(candidate, iconUrl, theme)
            ? "anonymous"
            : undefined
        }
        className={classNames(
          "relative block transition-opacity duration-150",
          loaded ? "opacity-100" : "opacity-0",
        )}
        style={{
          width: size,
          height: size,
          objectFit: "contain",
          imageRendering: "-webkit-optimize-contrast",
        }}
        onLoad={onImgLoad}
        onError={onImgError}
      />
    </span>
  );
}
