import { useMemo, useState, useEffect } from "react";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Module-level caches.
 *
 * `urlCache` memoises the derived favicon URL per (domain, size).
 * `failedUrls` records favicons that failed this session — sibling renders
 *   skip the network request and fall straight to the monogram.
 * `loadedUrls` records favicons that already resolved successfully — we
 *   skip the skeleton placeholder for instant paint on subsequent renders.
 * `prefetched` tracks URLs we've already hinted to the browser so we don't
 *   inject duplicate <link rel="prefetch"> tags.
 */
const urlCache = new Map<string, string>();
const failedUrls = new Set<string>();
const loadedUrls = new Set<string>();
const prefetched = new Set<string>();

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
  const url = `https://www.google.com/s2/favicons?sz=${size}&domain=${encodeURIComponent(host)}`;
  urlCache.set(key, url);
  return url;
}

/**
 * Derive (and cache) a favicon URL without rendering — call from list
 * components to prefetch icons for rows near the viewport. Safe to invoke
 * many times; duplicate requests are coalesced by the browser cache.
 */
export function prefetchBrandIcon(url?: string | null, size = 32): void {
  if (typeof window === "undefined") return;
  const host = extractHost(url);
  if (!host) return;
  const href = deriveFaviconUrl(host, size * 2);
  if (prefetched.has(href) || failedUrls.has(href) || loadedUrls.has(href)) return;
  prefetched.add(href);
  // Use Image() to warm the HTTP cache without polluting <head>; the browser
  // dedupes the real request issued by the eventual <img> render.
  try {
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onload = () => loadedUrls.add(href);
    img.onerror = () => failedUrls.add(href);
    img.src = href;
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
  name?: string | null;
  fallback?: string | number | null;
  size?: number;
  className?: string;
  /** Visually decorative (default). When false, exposes an aria-label. */
  decorative?: boolean;
}

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
  const [loaded, setLoaded] = useState(
    () => !!candidate && loadedUrls.has(candidate),
  );

  useEffect(() => {
    setErrored(!candidate || failedUrls.has(candidate));
    setLoaded(!!candidate && loadedUrls.has(candidate));
  }, [candidate]);

  const baseClasses = classNames(
    "relative inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded-md border border-border bg-surface",
    className,
  );
  const style = { width: size, height: size };
  const labelText = name ?? (fallback != null ? String(fallback) : "");
  const ariaLabel = decorative ? undefined : labelText ? `${labelText} icon` : "icon";
  const ariaHidden = decorative ? true : undefined;

  // Monogram fallback (no candidate or load failed).
  if (!candidate || errored) {
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

  // Image with skeleton placeholder until first paint.
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
        src={candidate}
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
        style={{ width: size, height: size, objectFit: "contain" }}
        onLoad={() => {
          loadedUrls.add(candidate);
          setLoaded(true);
        }}
        onError={() => {
          failedUrls.add(candidate);
          setErrored(true);
        }}
      />
    </span>
  );
}
