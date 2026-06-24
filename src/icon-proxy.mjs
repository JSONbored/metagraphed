// Brand-icon favicon proxy (#1124 frontend-surfacing) — implements the icon-proxy
// contract documented in metagraphed-ui src/lib/metagraphed/brand-overrides.ts:
//
//   GET /api/v1/icon?host={domain}&size={px}&theme={light|dark}
//   -> 200 image/png|x-icon (square, cached) | 404 when no source resolves
//
// Resolution order: (1) the host's OWN page-declared icon via <link rel="icon"> scraped
// from its HTML root — what actually resolves most real sites; (2) the favicon
// aggregators (DuckDuckGo, Google), usually bot-blocked from Worker egress; (3) the
// host's well-known favicon paths (apple-touch-icon / favicon.ico).
// SSRF SAFETY: `host` is validated to a plain public DNS name (no IP literals, no
// localhost/.local/.internal); page-declared icon URLs are re-validated the same way
// (public host, http(s) only) so a hostile page cannot redirect us at an internal
// target; the Worker runtime cannot reach private/internal addresses; the page fetch is
// size-capped and only an image/* response of sane size is ever returned. Results are
// cached in R2 (immutable) so repeat loads are a single edge read.
const ICON_CACHE_PREFIX = "icon-cache";
const MAX_SIZE = 256;
const DEFAULT_SIZE = 64;
const MIN_ICON_BYTES = 100; // reject empty / 1x1 placeholder responses
const MAX_ICON_BYTES = 256 * 1024; // bound Worker memory and R2 object size
const MAX_HTML_BYTES = 256 * 1024; // cap the page fetch when scraping <link rel=icon>
const MAX_PAGE_ICONS = 4; // most page-declared icons we will try
const FETCH_TIMEOUT_MS = 3000;
const CACHE_CONTROL = "public, max-age=2592000, immutable"; // 30d, per contract
const BLOCKED_TLDS = new Set(["localhost", "local", "internal"]);
// A real-ish UA — DuckDuckGo/Google's favicon endpoints and some origins bot-block
// the default Worker user-agent (a cause of the prod 404s).
const BROWSER_UA =
  "Mozilla/5.0 (compatible; MetagraphedIconBot/1.0; +https://metagraph.sh)";

function normalizeHost(input) {
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

function clampSize(input) {
  const n = Number.parseInt(String(input ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.max(16, Math.min(n, MAX_SIZE));
}

function hostFromUrl(value) {
  try {
    const url = new URL(String(value));
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

function collectHosts(value, hosts = new Set()) {
  if (!value || typeof value !== "object") return hosts;
  if (Array.isArray(value)) {
    for (const item of value) collectHosts(item, hosts);
    return hosts;
  }
  for (const [key, item] of Object.entries(value)) {
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

const allowlistMemo = new WeakMap();

async function iconHostAllowlist(env, options = {}) {
  const configured = String(env?.METAGRAPH_ICON_ALLOWED_HOSTS || "")
    .split(",")
    .map(normalizeHost)
    .filter(Boolean);
  if (!options.readArtifact) return new Set(configured);
  const cached = allowlistMemo.get(env);
  if (cached) return cached;
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
  allowlistMemo.set(env, hosts);
  return hosts;
}

async function boundedArrayBuffer(res) {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = await res.arrayBuffer();
    return buf.byteLength <= MAX_ICON_BYTES ? buf : null;
  }
  const chunks = [];
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

// Extract icon hrefs from raw HTML: every <link> whose rel contains "icon" (icon /
// shortcut icon / apple-touch-icon / mask-icon). A small targeted regex — NOT a general
// HTML parser — over a size-capped page head. Pure + exported for tests; runs identically
// in node + the Worker (Cloudflare's HTMLRewriter is unavailable in the unit-test
// runtime, so the tested path IS the prod path).
export function extractIconHrefs(html) {
  if (typeof html !== "string" || !html) return [];
  const attr = (tag, name) => {
    const m = new RegExp(
      `\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s">]+))`,
      "i",
    ).exec(tag);
    return m ? (m[2] ?? m[3] ?? m[4] ?? "") : "";
  };
  const hrefs = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!attr(tag, "rel").toLowerCase().includes("icon")) continue;
    const href = attr(tag, "href").trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

// Resolve page-declared hrefs to absolute, SSRF-safe http(s) URLs against the host.
// Rejects non-public hostnames (IP literals / private / localhost) so a hostile page
// cannot point us at an internal target. Deduped + capped.
function resolveIconUrls(hrefs, host) {
  const base = `https://${host}/`;
  const out = [];
  const seen = new Set();
  for (const href of hrefs) {
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "https:" && abs.protocol !== "http:") continue;
    if (!normalizeHost(abs.hostname)) continue; // SSRF: public DNS names only
    const s = abs.toString();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_PAGE_ICONS) break;
  }
  return out;
}

async function boundedText(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    return t.length > max ? t.slice(0, max) : t;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= max) {
        await reader.cancel();
        break;
      }
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
  return new TextDecoder("utf-8").decode(out);
}

// Fetch the host's HTML root and return its declared <link rel="icon"> URLs. THIS is
// what resolves most real sites: the favicon aggregators are bot-blocked from Worker
// egress and many sites serve no favicon at a literal root path, but nearly all declare
// one in the page <head>. Best-effort — any failure yields [] and the caller falls back.
async function pageDeclaredIconSources(host) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${host}/`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": BROWSER_UA,
      },
      redirect: "follow",
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));
    if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) {
      await res.body?.cancel?.();
      return [];
    }
    const html = await boundedText(res, MAX_HTML_BYTES);
    return resolveIconUrls(extractIconHrefs(html), host);
  } catch {
    return [];
  }
}

// Fallback sources, tried after the page-declared icons: the favicon aggregators
// (frequently bot-blocked from Worker egress) then the host's OWN well-known favicon
// paths. Fetching the host directly is SSRF-safe here: `host` is validated to a public
// DNS name (no IP literals / localhost / private TLDs) and the Worker runtime cannot
// reach private/internal addresses; we additionally only accept an image/* response.
function faviconSources(host, size) {
  return [
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=${Math.min(size * 2, MAX_SIZE)}`,
    `https://${host}/apple-touch-icon.png`,
    `https://${host}/apple-touch-icon-precomposed.png`,
    `https://${host}/favicon.ico`,
  ];
}

function etagFor(host, size) {
  return `"icon-${host}-${size}"`;
}

function imageResponse(body, contentType, etag, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType || "image/png",
      "cache-control": CACHE_CONTROL,
      etag,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function notFound() {
  return new Response("icon not found", {
    status: 404,
    headers: {
      "cache-control": "public, max-age=86400", // negative-cache a day
      "access-control-allow-origin": "*",
    },
  });
}

export async function handleIconProxy(request, env, url, options = {}) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const host = normalizeHost(url.searchParams.get("host"));
  if (!host) {
    return new Response("invalid host", {
      status: 400,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  const allowlist = await iconHostAllowlist(env, options);
  if (!allowlist.has(host)) {
    return notFound();
  }

  const size = clampSize(url.searchParams.get("size"));
  const etag = etagFor(host, size);
  if ((request.headers.get("if-none-match") || "") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": CACHE_CONTROL },
    });
  }

  const bucket = env?.METAGRAPH_ARCHIVE;
  const cacheKey = `${ICON_CACHE_PREFIX}/${host}/${size}`;

  // R2 cache hit -> single edge read.
  if (bucket?.get) {
    try {
      const cached = await bucket.get(cacheKey);
      if (cached) {
        const ct = cached.httpMetadata?.contentType || "image/png";
        return imageResponse(cached.body, ct, etag, { "x-icon-cache": "hit" });
      }
    } catch {
      // fall through to live resolution
    }
  }

  // Page-declared <link rel="icon"> first (the real fix), then aggregators + well-known
  // paths. Follow redirects (favicons often 30x to a CDN); no cf.cacheEverything (it
  // forced caching of redirect/non-200 responses and broke resolution) — successful
  // icons are cached in R2 below.
  const sources = [
    ...(await pageDeclaredIconSources(host)),
    ...faviconSources(host, size),
  ];
  for (const src of sources) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(src, {
        headers: { accept: "image/*", "user-agent": BROWSER_UA },
        redirect: "follow",
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!res.ok) continue;
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
      return imageResponse(buf, ct, etag, { "x-icon-cache": "miss" });
    } catch {
      // try the next source
    }
  }
  return notFound();
}
