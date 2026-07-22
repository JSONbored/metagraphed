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

// metagraphed#7687 (MCP execute Phase 3b): a query-location credential is,
// unavoidably, part of the request URL itself -- unlike a header/cookie
// credential (which never appears in any response field, this module never
// echoes request headers back), the URL is exactly what this module DOES
// return to the caller on both success and some failure paths. Only a
// query-location credential is ever redacted here; header/cookie placement
// has nothing in the URL to redact.
const REDACTED_CREDENTIAL_PLACEHOLDER = "<redacted>";
function redactQueryCredential(url, credential) {
  if (!url || credential?.location !== "query") return url;
  // No try/catch: `url` here is always the output of an earlier `new URL()`
  // call within this same module (buildRequestUrl, or safetyCheckedFetch's
  // own redirect-target construction) -- by the time it reaches here it has
  // already been proven parseable, so a second parse can't newly fail.
  const parsed = new URL(url);
  if (!parsed.searchParams.has(credential.name)) return url;
  parsed.searchParams.set(credential.name, REDACTED_CREDENTIAL_PLACEHOLDER);
  return parsed.toString();
}

// Regardless of credential location, scrub the raw value out of any
// free-form error string this module returns -- the underlying fetch
// implementation's own error text (network/timeout/DNS failures) is outside
// this module's control, and some implementations echo the request URL (or
// occasionally other request details) into it.
function redactCredentialValue(text, credential) {
  if (!text || !credential?.value) return text;
  return text.split(credential.value).join(REDACTED_CREDENTIAL_PLACEHOLDER);
}

/**
 * @typedef {object} CallSubnetSurfaceCredential
 * @property {"header" | "query" | "cookie"} location Where to place the credential -- mirrors the surface's own `auth.location`. The CALLER (call_subnet_surface's tool handler) is responsible for validating the surface's auth.scheme is generically supported (bearer/api-key) and auth.location/auth.name are both present BEFORE ever passing this; this function only places the value, it does not validate eligibility.
 * @property {string} name Header name, query-parameter name, or cookie name -- the surface's own `auth.name`.
 * @property {string} value The credential value exactly as supplied by the caller, inserted verbatim (never reformatted against `auth.value_format` -- the caller is expected to have already formatted it, e.g. "Bearer <token>").
 */

/**
 * @typedef {object} CallSubnetSurfaceOptions
 * @property {Record<string, string | number | boolean>} [query] Query params merged onto the effective base URL.
 * @property {string} [path] MCP execute Phase 2b (#7674) schema-validated path override -- the CALLER (call_subnet_surface's tool handler) is responsible for confirming this path is declared in the surface's captured schema via matchSchemaOperation BEFORE ever passing it here; this function does not validate it. When present, the request URL is this surface's own origin (never the OpenAPI document's own `servers[]` host) joined with this path, not `surface.url`.
 * @property {string} [method] Overrides the surface's probe-derived method (Phase 1 default). Ignored unless `path` is also set.
 * @property {string} [body] MCP execute Phase 2c (#7675) request body, already serialized to a string by the caller -- this function never serializes or validates it, only sends it as-is. Ignored unless `path` is also set; GET/HEAD never send a body regardless.
 * @property {string} [contentType] The `content-type` header to send alongside `body`. Ignored when `body` is not set.
 * @property {CallSubnetSurfaceCredential} [credential] MCP execute Phase 3a (#7686) caller-supplied credential to attach to the request. Unlike `body`/`method`, this applies regardless of whether `path` is set -- it attaches to whichever URL is already being called (the surface's own curated `url`, Phase 1, or a schema-validated `path` override, Phase 2), it never changes URL/path resolution itself.
 * @property {typeof fetch} [fetchImpl] Injectable fetch (tests; also threaded into isUnsafeUrl's own DoH lookups).
 * @property {(url: string) => Promise<boolean>} isUnsafeUrl Required -- the same DNS-rebinding-aware guard verify_integration uses (workerResolvedUrlSafetyGuard).
 */

/**
 * @param {{url: string, probe?: {method?: string, timeout_ms?: number}}} surface A catalog-resolved surface -- never a caller-supplied raw URL.
 * @param {CallSubnetSurfaceOptions} options
 */
export async function callSubnetSurface(surface, options) {
  const {
    query,
    path,
    method: methodOverride,
    body: requestBody,
    contentType: requestContentType,
    credential,
    fetchImpl = fetch,
    isUnsafeUrl,
  } = options ?? {};
  if (typeof isUnsafeUrl !== "function") {
    throw new Error("callSubnetSurface requires options.isUnsafeUrl");
  }
  // Placed before URL/header construction so a query-location credential
  // becomes part of the query object buildRequestUrl() merges below, and a
  // header/cookie-location credential is ready to hand to safetyCheckedFetch.
  let effectiveQuery = query;
  const extraHeaders = {};
  if (credential) {
    if (credential.location === "query") {
      effectiveQuery = {
        ...(query || {}),
        [credential.name]: credential.value,
      };
    } else if (credential.location === "header") {
      extraHeaders[credential.name] = credential.value;
    } else if (credential.location === "cookie") {
      extraHeaders.cookie = `${credential.name}=${credential.value}`;
    }
  }
  const method =
    path && methodOverride
      ? methodOverride
      : surface?.probe?.method === "HEAD"
        ? "HEAD"
        : "GET";
  // GET/HEAD never carry a body even if one was somehow supplied -- only the
  // tool handler's own POST/PUT validation path ever sets requestBody.
  const canHaveBody = path && (method === "POST" || method === "PUT");
  const timeoutMs = Number.isFinite(surface?.probe?.timeout_ms)
    ? surface.probe.timeout_ms
    : 10_000;
  let baseUrl = surface.url;
  if (path) {
    const surfaceOrigin = new URL(surface.url).origin;
    // A caller-supplied path like "//attacker.com" starts with "/" (passing
    // matchSchemaOperation's own format check, and its segment-splitting
    // treats it the same as "/attacker.com" since both produce the same
    // non-empty segments) but new URL() treats a leading "//" as a
    // protocol-relative reference, resolving to an entirely different host --
    // never this surface's own. matchSchemaOperation validates the SHAPE of
    // path against the schema; only this origin check validates WHERE the
    // resolved request actually goes, so it's the authoritative guard
    // regardless of what string tricked schema matching into a false match.
    const resolved = new URL(path, surfaceOrigin);
    if (resolved.origin !== surfaceOrigin) {
      return {
        ok: false,
        error: "path resolved outside the surface's own origin",
        path_origin_mismatch: true,
      };
    }
    baseUrl = resolved.toString();
  }
  const requestUrl = buildRequestUrl(baseUrl, effectiveQuery);

  const fetched = await safetyCheckedFetch(requestUrl, {
    method,
    ...(canHaveBody && requestBody !== undefined
      ? { body: requestBody, contentType: requestContentType }
      : {}),
    extraHeaders,
    fetchImpl,
    isUnsafeUrl,
    timeoutMs,
  });
  if (!fetched.ok) {
    // metagraphed#7687: a query-location credential (extraHeaders never
    // echoes back on any path, but a query param is part of the URL itself)
    // must never appear in a URL this function hands back, including a
    // blocked-redirect's own target -- redact it here, at the one place
    // that knows both the credential and every URL field that could carry
    // it, rather than trusting every caller to remember to scrub it.
    // error is scrubbed too, regardless of credential location: some fetch
    // implementations embed the request URL (or occasionally headers) in
    // their own thrown error text, and that's outside this module's control.
    return {
      ...fetched,
      ...(fetched.redirect_target
        ? {
            redirect_target: redactQueryCredential(
              fetched.redirect_target,
              credential,
            ),
          }
        : {}),
      ...(fetched.error
        ? { error: redactCredentialValue(fetched.error, credential) }
        : {}),
    };
  }

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
    url: redactQueryCredential(redirectTarget || requestUrl, credential),
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
 * Decides whether a concrete request `path` + `method` is declared in a
 * surface's captured OpenAPI document (metagraphed#7673, MCP execute Phase
 * 2a). Pure and synchronous -- no fetch, no I/O -- the gate `call_subnet_surface`
 * Phase 2 (#7674) runs before it will ever construct a request URL from a
 * caller-supplied path, so a surface's schema is the only thing that can
 * make a path/method combination callable, never a guess.
 *
 * A declared path template's `{param}` segments (OpenAPI's own syntax, e.g.
 * "/users/{id}") each match exactly one non-empty concrete path segment, any
 * value; every other segment must match literally. The template and the
 * concrete path must have the same segment count -- no partial/prefix
 * matches. Method comparison is case-insensitive on the `method` argument;
 * OpenAPI's own path-item keys are always lowercase (get/post/put/...), so
 * the caller-supplied method is lowercased before lookup.
 *
 * Returns `null` (never throws) when: no declared path template matches the
 * concrete path's shape, a template matches but doesn't declare an operation
 * for the requested method, or `document.paths` is missing/empty/malformed
 * -- callers can treat `null` as "reject the request" uniformly. Only throws
 * for genuinely malformed input (`path` not starting with "/", or a missing
 * `method`), never for a legitimate "not found in this schema" outcome.
 *
 * @param {{paths?: Record<string, Record<string, object>>}} document The `document` field `get_api_schema` returns for this surface.
 * @param {string} path Concrete request path, e.g. "/users/123" -- never a template.
 * @param {string} method HTTP method, case-insensitive (e.g. "POST" or "post").
 * @returns {{operation: object, matchedTemplate: string} | null}
 */
export function matchSchemaOperation(document, path, method) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(
      'matchSchemaOperation: path must be a string starting with "/".',
    );
  }
  if (typeof method !== "string" || !method) {
    throw new Error("matchSchemaOperation: method must be a non-empty string.");
  }
  const paths = document?.paths;
  if (!paths || typeof paths !== "object") return null;

  const requestSegments = splitPathSegments(path);
  const normalizedMethod = method.toLowerCase();

  for (const [template, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    if (!segmentsMatch(splitPathSegments(template), requestSegments)) {
      continue;
    }
    const operation = pathItem[normalizedMethod];
    if (!operation || typeof operation !== "object") continue;
    return { operation, matchedTemplate: template };
  }
  return null;
}

// Query/fragment stripped defensively -- callers should only ever pass a
// bare path, but this keeps a stray "?x=1" from corrupting the last segment.
// Empty segments (leading/trailing/doubled slashes) are dropped on both
// sides before comparison, so "/a//b" and "/a/b" are treated the same way.
function splitPathSegments(rawPath) {
  return rawPath
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .filter((segment) => segment.length > 0);
}

function segmentsMatch(templateSegments, requestSegments) {
  if (templateSegments.length !== requestSegments.length) return false;
  return templateSegments.every((templateSegment, index) => {
    if (templateSegment.startsWith("{") && templateSegment.endsWith("}")) {
      return requestSegments[index].length > 0;
    }
    return templateSegment === requestSegments[index];
  });
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
  {
    method,
    fetchImpl,
    isUnsafeUrl,
    timeoutMs,
    body,
    contentType,
    extraHeaders,
    redirectCount = 0,
  },
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
        ...(body !== undefined && contentType
          ? { "content-type": contentType }
          : {}),
        ...(extraHeaders || {}),
      },
      ...(body !== undefined ? { body } : {}),
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
      // metagraphed#7686: extraHeaders may carry a caller's credential
      // (Authorization/api-key/Cookie) -- forwarding it across an origin
      // boundary would hand it to a host the caller never authorized,
      // exactly the class of leak real HTTP clients guard against by
      // stripping Authorization on a cross-origin redirect. This code
      // manually re-issues each hop (redirect: "manual"), so that stripping
      // doesn't happen for free; drop extraHeaders the moment the redirect
      // target's origin differs from the current hop's, and it stays
      // dropped for every hop after (a stripped call never receives it back).
      const sameOrigin = new URL(redirectTarget).origin === new URL(url).origin;
      return safetyCheckedFetch(redirectTarget, {
        method,
        fetchImpl,
        isUnsafeUrl,
        timeoutMs,
        body,
        contentType,
        extraHeaders: sameOrigin ? extraHeaders : undefined,
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
