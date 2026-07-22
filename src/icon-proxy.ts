// Brand-icon favicon proxy (#1124 frontend-surfacing) — implements the icon-proxy
// contract documented in metagraphed-ui src/lib/metagraphed/brand-overrides.ts:
//
//   GET /api/v1/icon?host={domain}&size={px}&theme={light|dark}
//   -> 200 image/png|x-icon (square, cached) | 404 when no source resolves
//
// SSRF SAFETY: this Worker fetches ONLY the fixed favicon-aggregator origins
// (icons.duckduckgo.com, www.google.com). The requested `host` is passed solely as a
// path/query parameter to those constant origins — it never becomes the request target
// itself — so an operator-controlled or DNS-rebound registry host cannot make the proxy
// initiate outbound requests to arbitrary infrastructure. `host` is additionally
// validated to a plain public DNS name (no IP literals, no localhost/.local/.internal),
// and only an image/* response of sane size is ever returned. Results are cached in R2
// (immutable) so repeat loads are a single edge read.
//
// NOTE: we deliberately do NOT fetch the host directly (no <link rel=icon> scrape, no
// direct /favicon.ico). Those add an SSRF surface for marginal gain — aggregators are
// often bot-blocked from Worker egress anyway, and the UI's GitHub-avatar fallback
// (BrandIcon repoUrl) is the real icon source for most subnets.
import type { StorageReadResult } from "../workers/storage.ts";

const ICON_CACHE_PREFIX = "icon-cache";
const MAX_SIZE = 256;
const DEFAULT_SIZE = 64;
const MIN_ICON_BYTES = 100; // reject empty / 1x1 placeholder responses
const MAX_ICON_BYTES = 256 * 1024; // bound Worker memory and R2 object size
const FETCH_TIMEOUT_MS = 3000;
const CACHE_CONTROL = "public, max-age=2592000, immutable"; // 30d, per contract
// Negative-cache windows split by cause: a structurally-invalid / non-allowlisted
// host is a stable "no" (cache a day), but an allowlisted host whose upstream
// aggregators *transiently* failed must retry soon — otherwise one bad minute
// blackholes a real icon for 24h. (#1124 frontend-surfacing freshness audit.)
const NEGATIVE_CACHE_STABLE = "public, max-age=86400"; // 24h — won't resolve
const NEGATIVE_CACHE_TRANSIENT = "public, max-age=600"; // 10m — retry soon
const BLOCKED_TLDS = new Set(["localhost", "local", "internal"]);
// A real-ish UA — DuckDuckGo/Google's favicon endpoints bot-block the default Worker
// user-agent (a cause of the prod 404s).
const BROWSER_UA =
  "Mozilla/5.0 (compatible; MetagraphedIconBot/1.0; +https://metagraph.sh)";

function normalizeHost(input: unknown): string | null {
  const host = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  // IP literals (v4/v6) are never valid public hosts here.
  if (host.includes(":") || host.startsWith("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!tld || BLOCKED_TLDS.has(tld)) return null;
  // Reject a 4-numeric-label IPv4 literal (e.g. 10.0.0.1).
  if (labels.length === 4 && labels.every((l) => /^\d{1,3}$/.test(l)))
    return null;
  const ok = labels.every(
    (l) =>
      l.length > 0 &&
      l.length <= 63 &&
      /^[a-z0-9-]+$/.test(l) &&
      !l.startsWith("-") &&
      !l.endsWith("-"),
  );
  return ok ? host : null;
}

function clampSize(input: unknown): number {
  const n = Number.parseInt(String(input ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(16, Math.min(n, MAX_SIZE));
}

function hostFromUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

function collectHosts(
  value: unknown,
  hosts: Set<string> = new Set(),
): Set<string> {
  if (!value || typeof value !== "object") return hosts;
  if (Array.isArray(value)) {
    for (const item of value) collectHosts(item, hosts);
    return hosts;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      (key === "url" || key === "base_url" || key === "website") &&
      typeof item === "string"
    ) {
      const host = hostFromUrl(item);
      if (host) hosts.add(host);
    } else if (item && typeof item === "object") {
      collectHosts(item, hosts);
    }
  }
  return hosts;
}

interface IconProxyOptions {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  now?: number;
}

// In-isolate memo of the derived host allowlist, TTL'd so a newly published
// provider/subnet host becomes allowed within one interval instead of staying
// rejected until the isolate recycles. Same {env, value, expiresAt} pattern as
// the Worker's readHealthMetaKv (#1375); the previous WeakMap had no expiry.
const ICON_ALLOWLIST_TTL_MS = 300_000; // 5 min
let allowlistMemo: {
  env: Env | null;
  value: Set<string> | null;
  expiresAt: number;
} = { env: null, value: null, expiresAt: 0 };

async function iconHostAllowlist(
  env: Env,
  options: IconProxyOptions = {},
  now: number = Date.now(),
): Promise<Set<string>> {
  const configured = String(env?.METAGRAPH_ICON_ALLOWED_HOSTS || "")
    .split(",")
    .map(normalizeHost)
    .filter((h): h is string => Boolean(h));
  if (!options.readArtifact) return new Set(configured);
  if (allowlistMemo.env === env && now < allowlistMemo.expiresAt) {
    return allowlistMemo.value as Set<string>;
  }
  const hosts = new Set(configured);
  for (const path of [
    "/metagraph/subnets.json",
    "/metagraph/providers.json",
    "/metagraph/operational-surfaces.json",
  ]) {
    try {
      const artifact = await options.readArtifact(env, path);
      if (artifact?.ok) collectHosts(artifact.data, hosts);
    } catch {
      // Missing artifacts fail closed except for explicit configured hosts.
    }
  }
  allowlistMemo = { env, value: hosts, expiresAt: now + ICON_ALLOWLIST_TTL_MS };
  return hosts;
}

async function boundedArrayBuffer(res: Response): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    return buf.byteLength <= MAX_ICON_BYTES ? buf : null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ICON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

// FIXED aggregator origins ONLY — the host is a path/query param, never the request
// target. Do NOT add `https://${host}/...` entries here: fetching a registry-controlled
// host directly is an SSRF surface (operator-controlled / DNS-rebindable) for marginal
// gain. The UI's GitHub-avatar fallback covers most subnets.
function faviconSources(host: string, size: number): string[] {
  return [
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=${Math.min(size * 2, MAX_SIZE)}`,
  ];
}

function etagFor(host: string, size: number): string {
  return `"icon-${host}-${size}"`;
}

// A HEAD must carry the same status + headers as the GET but no body (mirrors the
// discovery handler's `request.method === "HEAD" ? null : ...`). We pass the GET's
// byte length through so HEAD still advertises an accurate content-length.
function imageResponse(
  body: ArrayBuffer | ReadableStream | null,
  contentType: string | null | undefined,
  etag: string,
  extra: Record<string, string> = {},
  head = false,
): Response {
  const byteLength =
    body && typeof body === "object" && "byteLength" in body
      ? (body as ArrayBuffer).byteLength
      : null;
  const headers: Record<string, string> = {
    "content-type": contentType || "image/png",
    "cache-control": CACHE_CONTROL,
    etag,
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
    ...extra,
  };
  if (head && byteLength != null)
    headers["content-length"] = String(byteLength);
  return new Response(head ? null : body, { status: 200, headers });
}

function notFound(cacheControl: string = NEGATIVE_CACHE_STABLE): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "cache-control": cacheControl,
      "access-control-allow-origin": "*",
    },
  });
}

export async function handleIconProxy(
  request: Request,
  env: Env,
  url: URL,
  options: IconProxyOptions = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  const isHead = request.method === "HEAD";
  const host = normalizeHost(url.searchParams.get("host"));
  if (!host) {
    return new Response("invalid host", {
      status: 400,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  const now = typeof options.now === "number" ? options.now : Date.now();
  const allowlist = await iconHostAllowlist(env, options, now);
  if (!allowlist.has(host)) {
    // Stable "no": this host isn't (yet) a registered surface. Cache a full day.
    return notFound(NEGATIVE_CACHE_STABLE);
  }

  const size = clampSize(url.searchParams.get("size"));
  const etag = etagFor(host, size);
  if ((request.headers.get("if-none-match") || "") === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        etag,
        "cache-control": CACHE_CONTROL,
        "access-control-allow-origin": "*",
      },
    });
  }

  const bucket = env?.METAGRAPH_ARCHIVE;
  const cacheKey = `${ICON_CACHE_PREFIX}/${host}/${size}`;

  // R2 cache hit -> single edge read. A HEAD short-circuits to a bodyless 200 but
  // still wants an accurate content-length, so prefer R2's stored object size and
  // release the body stream we won't send.
  if (bucket?.get) {
    try {
      const cached = await bucket.get(cacheKey);
      if (cached) {
        const ct = cached.httpMetadata?.contentType || "image/png";
        const extra: Record<string, string> = { "x-icon-cache": "hit" };
        if (isHead) {
          if (typeof cached.size === "number")
            extra["content-length"] = String(cached.size);
          await (cached.body as ReadableStream | undefined)?.cancel?.();
          return imageResponse(null, ct, etag, extra, true);
        }
        return imageResponse(cached.body as ReadableStream, ct, etag, extra);
      }
    } catch {
      // fall through to live resolution
    }
  }

  // Try each fixed aggregator. A browser-ish UA (the services bot-block the default
  // Worker UA); follow redirects (the aggregators 30x to their own CDNs); no
  // cf.cacheEverything (it forced caching of redirect/non-200 responses and broke
  // resolution) — successful icons are cached in R2 below.
  //
  // Track whether any source *transiently* failed (network error / timeout / abort,
  // or a 5xx upstream) vs. a clean negative (4xx / non-image). An allowlisted host
  // that only saw transient failures must be retried soon, so it gets the short
  // negative-cache window; a clean negative is a stable "no" and keeps 24h.
  let transient = false;
  for (const src of faviconSources(host, size)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(src, {
        headers: { accept: "image/*", "user-agent": BROWSER_UA },
        redirect: "follow",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!res.ok) {
        // Transient (retry soon), not a stable "no": 5xx upstream blips, the
        // retryable 4xx (408 timeout, 429 rate-limit), and 403 — the anti-bot
        // block these aggregators return to non-browser UAs, which is the exact
        // prod failure this module works around (see the BROWSER_UA note above).
        // Blackholing any of these as a 24h stable negative would drop a real,
        // resolvable icon for a full day.
        if (
          res.status >= 500 ||
          res.status === 429 ||
          res.status === 408 ||
          res.status === 403
        )
          transient = true;
        continue;
      }
      const ct = res.headers.get("content-type") || "image/png";
      if (!ct.startsWith("image/")) {
        await res.body?.cancel?.();
        continue;
      }
      const buf = await boundedArrayBuffer(res);
      if (!buf || buf.byteLength < MIN_ICON_BYTES) continue; // skip empty/placeholder/oversized
      if (bucket?.put) {
        try {
          await bucket.put(cacheKey, buf, {
            httpMetadata: { contentType: ct, cacheControl: CACHE_CONTROL },
          });
        } catch {
          // caching is best-effort
        }
      }
      return imageResponse(buf, ct, etag, { "x-icon-cache": "miss" }, isHead);
    } catch {
      // A thrown fetch is a network error / timeout / abort — transient.
      transient = true;
    }
  }
  // Allowlisted host, every source failed: short window if it was transient (retry
  // soon), full day if every source gave a clean negative.
  return notFound(transient ? NEGATIVE_CACHE_TRANSIENT : NEGATIVE_CACHE_STABLE);
}
