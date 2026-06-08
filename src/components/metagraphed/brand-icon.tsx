import { useMemo, useState, useEffect, useCallback } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { useTheme, type ResolvedTheme } from "@/lib/theme";
import {
  resolveBrandOverride,
  buildProxyIconUrl,
  pickIconSource,
  type BrandOverrideLookup,
  type IconSource,
} from "@/lib/metagraphed/brand-overrides";

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
    if (!u.hostname.endsWith("github.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] ?? null;
  } catch {
    return null;
  }
}

function duckDuckGoUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
}

function googleS2Url(host: string, size = 128): string {
  return `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(host)}`;
}

function githubAvatarUrl(org: string, size = 192): string {
  return `https://github.com/${encodeURIComponent(org)}.png?size=${size}`;
}

interface ChainInputs {
  url?: string | null;
  iconUrl?: IconSource | null;
  repoUrl?: string | null;
  lookup?: BrandOverrideLookup;
  theme: ResolvedTheme;
  size: number;
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
    if (!u) return;
    if (failedUrls.has(u)) return;
    if (!out.includes(u)) out.push(u);
  };

  push(pickIconSource(iconUrl, theme));
  if (lookup) push(resolveBrandOverride(lookup, theme));

  const host = extractHost(url);
  if (host) push(buildProxyIconUrl(host, size * 2, theme));

  const repoOrg = githubOrgFromUrl(repoUrl);
  if (repoOrg) push(githubAvatarUrl(repoOrg, 192));

  if (host) {
    push(duckDuckGoUrl(host));
    push(googleS2Url(host, 128));
  }
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
    img.onload = () => loadedUrls.add(first);
    img.onerror = () => failedUrls.add(first);
    img.src = first;
  } catch {
    /* ignore */
  }
}

function monogramFor(name?: string | null, fallback?: string | number | null): string {
  const source = (name ?? "").trim();
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
      const min = Math.max(16, Math.floor(size * 0.9));
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
  const ariaLabel = decorative ? undefined : labelText ? `${labelText} icon` : "icon";
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
          className="absolute inset-0 animate-pulse bg-accent/10"
        />
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
        crossOrigin="anonymous"
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
