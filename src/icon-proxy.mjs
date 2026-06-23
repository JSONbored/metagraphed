// Brand-icon favicon proxy (#1124 frontend-surfacing) — implements the icon-proxy
// contract documented in metagraphed-ui src/lib/metagraphed/brand-overrides.ts:
//
//   GET /api/v1/icon?host={domain}&size={px}&theme={light|dark}
//   -> 200 image/png|x-icon (square, cached) | 404 when no source resolves
//
// SSRF SAFETY: we NEVER fetch the caller-supplied host directly. We only fetch from
// FIXED, trusted favicon services (DuckDuckGo, Google), passing the validated host as
// a query param — so a malicious host can never make the Worker hit an internal/private
// target. The host is additionally validated to be a plain public DNS name (no IP
// literals, no localhost/.local/.internal). Results are cached in R2 (immutable) so
// repeat loads are a single edge read.
const ICON_CACHE_PREFIX = "icon-cache";
const MAX_SIZE = 256;
const DEFAULT_SIZE = 64;
const MIN_ICON_BYTES = 100; // reject empty / 1x1 placeholder responses
const MAX_ICON_BYTES = 256 * 1024; // bound Worker memory and R2 object size
const FETCH_TIMEOUT_MS = 3000;
const CACHE_CONTROL = "public, max-age=2592000, immutable"; // 30d, per contract
const BLOCKED_TLDS = new Set(["localhost", "local", "internal"]);

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

// Fixed trusted services only — the host is a param, never a fetch target itself.
function faviconSources(host, size) {
  return [
    `https://icons.duckduckgo.com/ip3/${host}.ico`,
    `https://www.google.com/s2/favicons?domain=${host}&sz=${Math.min(size * 2, MAX_SIZE)}`,
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

  for (const src of faviconSources(host, size)) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(src, {
        headers: { accept: "image/*" },
        cf: { cacheTtl: 2592000, cacheEverything: true },
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
