import { useMemo, useState, useEffect, useCallback } from "react";
import { classNames } from "@/lib/metagraphed/format";
import {
  resolveBrandOverride,
  type BrandOverrideLookup,
} from "@/lib/metagraphed/brand-overrides";

/**
 * Multi-source favicon resolution with low-resolution rejection.
 *
 * The chain (in priority order):
 *   1. Explicit `iconUrl` prop (curated CDN logo or API-provided override).
 *   2. Curated provider/subnet override map.
 *   3. GitHub org avatar derived from a `repo` URL (always >=128 crisp).
 *   4. DuckDuckGo icon service — usually serves the site's largest favicon.
 *   5. Google S2 at sz=128 — broad coverage, often upscaled.
 *   6. Monogram tile.
 *
 * We advance to the next candidate on either:
 *   - `<img>` `onError`, or
 *   - `onLoad` where `naturalWidth < displaySize` (would render blurry).
 *
 * Successful and failed candidates are memoised at module scope so the chain
 * is walked at most once per source URL per session.
 */

const failedUrls = new Set<string>();
const loadedUrls = new Set<string>();
const prefetched = new Set<string>();
/** Per-host winning candidate URL — short-circuits the chain on rerender. */
const winnerByHost = new Map<string, string>();

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
  iconUrl?: string | null;
  repoUrl?: string | null;
  lookup?: BrandOverrideLookup;
}

function buildCandidateChain({
  url,
  iconUrl,
  repoUrl,
  lookup,
}: ChainInputs): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u) return;
    if (failedUrls.has(u)) return;
    if (!out.includes(u)) out.push(u);
  };

  if (iconUrl) push(iconUrl);
  if (lookup) push(resolveBrandOverride(lookup));

  const repoOrg = githubOrgFromUrl(repoUrl);
  if (repoOrg) push(githubAvatarUrl(repoOrg, 192));

  const host = extractHost(url);
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
  _size = 32,
  extra?: { iconUrl?: string | null; repoUrl?: string | null; lookup?: BrandOverrideLookup },
): void {
  if (typeof window === "undefined") return;
  const chain = buildCandidateChain({
    url,
    iconUrl: extra?.iconUrl,
    repoUrl: extra?.repoUrl,
    lookup: extra?.lookup,
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

export interface BrandIconProps {
  url?: string | null;
  iconUrl?: string | null;
  repoUrl?: string | null;
  name?: string | null;
  fallback?: string | number | null;
  size?: number;
  className?: string;
  /** Visually decorative (default). When false, exposes an aria-label. */
  decorative?: boolean;
  /** Identifiers used to look up curated icon overrides. */
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
  const host = useMemo(() => extractHost(url), [url]);

  const lookup = useMemo<BrandOverrideLookup>(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid],
  );

  const chain = useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup }),
    [url, iconUrl, repoUrl, lookup],
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

  // Reset when inputs change.
  useEffect(() => {
    setIndex(initialIndex);
    setLoaded(false);
  }, [initialIndex, chain]);

  const candidate = chain[index] ?? null;
  const exhausted = !candidate;

  // If this candidate previously loaded, mark loaded immediately to skip
  // the skeleton flash on remount.
  useEffect(() => {
    if (candidate && loadedUrls.has(candidate)) setLoaded(true);
  }, [candidate]);

  const advance = useCallback(() => {
    setIndex((i) => i + 1);
    setLoaded(false);
  }, []);

  const onImgError = useCallback(() => {
    if (candidate) failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);

  const onImgLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const img = e.currentTarget;
      // Reject results that would be upscaled (blurry). Allow a small
      // tolerance — some services return a square close to but slightly
      // under the requested size.
      const min = Math.max(16, Math.floor(size * 0.9));
      if (img.naturalWidth > 0 && img.naturalWidth < min) {
        if (candidate) failedUrls.add(candidate);
        advance();
        return;
      }
      if (candidate) {
        loadedUrls.add(candidate);
        if (host) winnerByHost.set(host, candidate);
      }
      setLoaded(true);
    },
    [candidate, advance, host, size],
  );

  const baseClasses = classNames(
    "relative inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded-md border border-border bg-surface",
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
