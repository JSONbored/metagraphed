import { useMemo, useState, useEffect } from "react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Module-level caches.
 *
 * `urlCache` memoises the derived favicon URL per (domain, size) so we
 * avoid rebuilding/parsing strings on every render across many cards.
 *
 * `failedUrls` records favicon URLs that failed to load this session so
 * sibling/repeat renders skip the network request entirely and fall back
 * to the monogram tile immediately.
 */
const urlCache = new Map<string, string>();
const failedUrls = new Set<string>();

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

function deriveFaviconUrl(host: string, size: number): string {
  const key = `${host}@${size}`;
  const cached = urlCache.get(key);
  if (cached) return cached;
  // Google's S2 favicon service: stable, CDN-backed, returns transparent PNG.
  const url = `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(host)}`;
  urlCache.set(key, url);
  return url;
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
  /** Website or homepage URL — favicon is derived from this domain. */
  url?: string | null;
  /** Optional explicit icon URL override from the API; wins over favicon. */
  iconUrl?: string | null;
  /** Entity name used for the monogram fallback. */
  name?: string | null;
  /** Secondary fallback for monogram (e.g. subnet netuid). */
  fallback?: string | number | null;
  /** Rendered size in CSS pixels. Defaults to 32. */
  size?: number;
  className?: string;
  /** Visually hidden when true (icon is purely decorative). */
  decorative?: boolean;
}

/**
 * Branded icon tile for providers and subnets.
 *
 * Source priority:
 *   1. Explicit `iconUrl` (API override).
 *   2. Favicon derived from `url` (Google S2 endpoint, 2× pixel density).
 *   3. Monogram tile built from `name` / `fallback`.
 *
 * Failed image loads are remembered for the session so we never re-fire
 * the same broken request from a sibling card.
 */
export function BrandIcon({
  url,
  iconUrl,
  name,
  fallback,
  size = 32,
  className,
  decorative = true,
}: BrandIconProps) {
  const host = useMemo(() => extractHost(url), [url]);
  const fetchSize = size * 2;

  const candidate = useMemo(() => {
    if (iconUrl) return iconUrl;
    if (host) return deriveFaviconUrl(host, fetchSize);
    return null;
  }, [iconUrl, host, fetchSize]);

  const [errored, setErrored] = useState(
    () => !candidate || failedUrls.has(candidate),
  );

  // Reset error state when the candidate changes (e.g. provider switched).
  useEffect(() => {
    setErrored(!candidate || failedUrls.has(candidate));
  }, [candidate]);

  const baseClasses = classNames(
    "inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded-md border border-border bg-surface",
    className,
  );
  const style = { width: size, height: size };
  const label = name ?? (fallback != null ? String(fallback) : "");

  if (!candidate || errored) {
    return (
      <span
        className={classNames(baseClasses, "bg-accent/10 text-ink-strong")}
        style={style}
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : `${label} icon`}
        title={decorative ? undefined : label}
      >
        <span
          className="font-display font-semibold tabular-nums leading-none"
          style={{ fontSize: Math.max(10, Math.round(size * 0.42)) }}
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
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `${label} icon`}
      title={decorative ? undefined : label}
    >
      <img
        src={candidate}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="block"
        style={{ width: size, height: size, objectFit: "contain" }}
        onError={() => {
          failedUrls.add(candidate);
          setErrored(true);
        }}
      />
    </span>
  );
}
