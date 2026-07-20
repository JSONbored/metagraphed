// Safety-checked fetch-and-return-body for the call_subnet_surface MCP tool
// (metagraphed#7014, MCP execute Phase 1). This is the first MCP tool that
// performs a live outbound fetch to a curated third-party surface URL and
// returns its response content to the caller -- every existing tool either
// serves a pre-published artifact or, in verify_integration's case, probes
// a surface via src/health-probe-core.mjs's probeSurface() and returns only
// health/status metadata, never the body (probeUrl explicitly cancels the
// response body on every branch -- src/health-probe-core.mjs:216,228,245).
//
// Deliberately NOT built by refactoring health-probe-core.mjs's probeUrl to
// also expose the body: that file backs the live 15-minute health cron and
// verify_integration, both already in production, and reshaping its return
// contract is a materially higher blast radius than adding this isolated
// module. Instead this reimplements probeUrl's exact redirect-revalidation
// SHAPE (manual redirect handling, re-checking isUnsafeUrl on every hop, up
// to the same 5-hop cap) while reusing the actual security-critical piece
// unchanged: the isUnsafeUrl callback itself (workerResolvedUrlSafetyGuard,
// src/health-prober.mjs), which callers are required to supply -- this
// module never chooses or weakens the safety policy, only structurally
// mirrors the loop that applies it.
const MAX_REDIRECTS = 5;
// 256 KiB -- generous for a JSON API response, small enough that a
// misbehaving/adversarial upstream can't use this tool as a bandwidth sink.
export const MAX_RESPONSE_BYTES = 262_144;

// JSON-ish types are parsed and returned as structured data; other text
// types are returned as a capped string. Anything else (images, video,
// octet-stream, ...) is rejected outright per #7014's own scope ("reject/
// truncate unexpected binary") -- there is no sane way to return binary
// content through a JSON-RPC tool result body anyway.
function classifyContentType(contentType) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  if (!type) return "unknown";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (
    type.startsWith("text/") ||
    type === "application/xml" ||
    type.endsWith("+xml")
  ) {
    return "text";
  }
  return "binary";
}

function buildRequestUrl(baseUrl, query) {
  const url = new URL(baseUrl);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * @typedef {object} CallSubnetSurfaceOptions
 * @property {Record<string, string | number | boolean>} [query] Query params merged onto the surface's curated URL.
 * @property {typeof fetch} [fetchImpl] Injectable fetch (tests; also threaded into isUnsafeUrl's own DoH lookups).
 * @property {(url: string) => Promise<boolean>} isUnsafeUrl Required -- the same DNS-rebinding-aware guard verify_integration uses (workerResolvedUrlSafetyGuard).
 */

/**
 * @param {{url: string, probe?: {method?: string, timeout_ms?: number}}} surface A catalog-resolved surface -- never a caller-supplied raw URL.
 * @param {CallSubnetSurfaceOptions} options
 */
export async function callSubnetSurface(surface, options) {
  const { query, fetchImpl = fetch, isUnsafeUrl } = options ?? {};
  if (typeof isUnsafeUrl !== "function") {
    throw new Error("callSubnetSurface requires options.isUnsafeUrl");
  }
  const method = surface?.probe?.method === "HEAD" ? "HEAD" : "GET";
  const timeoutMs = Number.isFinite(surface?.probe?.timeout_ms)
    ? surface.probe.timeout_ms
    : 10_000;
  const requestUrl = buildRequestUrl(surface.url, query);

  const fetched = await safetyCheckedFetch(requestUrl, {
    method,
    fetchImpl,
    isUnsafeUrl,
    timeoutMs,
  });
  if (!fetched.ok) return fetched;

  const { response, latencyMs, redirectTarget } = fetched;
  const contentType = response.headers.get("content-type") || null;
  const kind = classifyContentType(contentType);
  if (kind === "binary") {
    await response.body?.cancel();
    return {
      ok: false,
      // contentType is guaranteed non-empty here: classifyContentType only
      // returns "binary" when it derived a non-empty type from it.
      error: `unsupported content-type: ${contentType}`,
      status_code: response.status,
      content_type: contentType,
      latency_ms: latencyMs,
    };
  }

  const raw = await readBodyCapped(response, MAX_RESPONSE_BYTES);
  let body = raw.text;
  let parseError = null;
  if (kind === "json" && raw.text) {
    try {
      body = JSON.parse(raw.text);
    } catch (err) {
      parseError = err.message;
    }
  }

  return {
    ok: true,
    status_code: response.status,
    content_type: contentType,
    latency_ms: latencyMs,
    url: redirectTarget || requestUrl,
    body,
    truncated: raw.truncated,
    ...(parseError ? { parse_error: parseError } : {}),
  };
}

/**
 * Reads a Response body up to `maxBytes`, decoding as UTF-8 text. Returns
 * `{text, truncated}` rather than throwing on an oversized body -- a
 * truncated response is still useful to an agent, unlike an outright
 * failure.
 */
async function readBodyCapped(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    return { text, truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        const allowed = value.byteLength - (received - maxBytes);
        if (allowed > 0)
          text += decoder.decode(value.subarray(0, allowed), { stream: true });
        truncated = true;
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  return { text, truncated };
}

/**
 * Mirrors src/health-probe-core.mjs's probeUrl redirect-revalidation loop
 * (manual redirect handling, isUnsafeUrl re-checked on every hop, 5-hop
 * cap) but returns the live Response on success instead of discarding the
 * body -- see this module's own header for why that isn't done by
 * refactoring probeUrl itself.
 */
async function safetyCheckedFetch(
  url,
  { method, fetchImpl, isUnsafeUrl, timeoutMs, redirectCount = 0 },
) {
  if (await isUnsafeUrl(url)) {
    return { ok: false, error: "unsafe URL", unsafe_url: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/json, text/*;q=0.8, */*;q=0.5",
        "user-agent": "metagraphed-mcp-call-subnet-surface/0.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    const location = response.headers.get("location");
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      location &&
      redirectCount < MAX_REDIRECTS
    ) {
      const redirectTarget = new URL(location, url).toString();
      await response.body?.cancel();
      if (await isUnsafeUrl(redirectTarget)) {
        return {
          ok: false,
          error: "redirect target is unsafe",
          private_redirect_blocked: true,
          redirect_target: redirectTarget,
          status_code: response.status,
        };
      }
      return safetyCheckedFetch(redirectTarget, {
        method,
        fetchImpl,
        isUnsafeUrl,
        timeoutMs,
        redirectCount: redirectCount + 1,
      });
    }
    return {
      ok: true,
      response,
      latencyMs,
      redirectTarget: redirectCount > 0 ? url : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}
