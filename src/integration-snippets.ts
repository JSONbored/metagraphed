// Ready-to-run integration snippets (issue #351): given a callable service's
// base_url + declared auth, emit copy-paste curl / Python / TypeScript that does
// a GET against the service — the fastest path to a first successful call.
// Worker-safe (pure string ops, no node deps) so the build generates them once
// into the agent-catalog and the Worker/MCP can regenerate on demand if needed.
//
// We snippet a GET of the surface URL itself (always a valid, documented entry
// point regardless of surface kind); for subnet-api surfaces with a captured
// schema the agent then reads it (get_api_schema) for specific endpoints. Auth
// uses the structured `auth` detail (#746) — the exact header/param name + a
// value PLACEHOLDER derived from the spec's securitySchemes or curated — and
// only falls back to a scheme-type guess when no structured detail is present.

interface AuthCredential {
  location: "header" | "query" | "cookie";
  name: string;
  value: string;
}

// Resolve the structured per-surface auth (#746) into a snippet-ready credential:
// { location: "header"|"query"|"cookie", name, value-placeholder }. Returns null
// for no auth or an unsafe placeholder (a placeholder must never break snippet
// quoting, and is never a real secret). The surface schema's auth.location enum is
// header|query|cookie — a cookie credential is rendered as a Cookie header below.
function authFromDetail(auth: unknown): AuthCredential | null {
  if (!auth || typeof auth !== "object") return null;
  const authObj = auth as Record<string, unknown>;
  const scheme = String(authObj.scheme || "").toLowerCase();
  if (scheme === "none") return null;
  const location: AuthCredential["location"] =
    authObj.location === "query"
      ? "query"
      : authObj.location === "cookie"
        ? "cookie"
        : "header";
  const name =
    typeof authObj.name === "string" && authObj.name
      ? authObj.name
      : location === "query"
        ? "api_key"
        : location === "cookie"
          ? "session"
          : "Authorization";
  const value =
    typeof authObj.value_format === "string" && authObj.value_format
      ? authObj.value_format
      : scheme === "api-key"
        ? "YOUR_API_KEY"
        : scheme === "basic"
          ? "Basic <base64(user:pass)>"
          : "Bearer YOUR_API_KEY";
  if (/['"`\\\n]/.test(name) || /['"`\\\n]/.test(value)) return null;
  return { location, name, value };
}

function authHeaderForSchemes(schemes: unknown): {
  name: string;
  value: string;
} {
  const types = new Set(
    (Array.isArray(schemes) ? schemes : []).map((scheme) =>
      String(scheme).toLowerCase(),
    ),
  );
  if (
    types.has("http") ||
    types.has("bearer") ||
    types.has("oauth2") ||
    types.has("openidconnect")
  ) {
    return { name: "Authorization", value: "Bearer YOUR_API_KEY" };
  }
  if (types.has("apikey")) {
    return { name: "X-API-Key", value: "YOUR_API_KEY" };
  }
  // Auth required but scheme unknown — a generic bearer placeholder + a hint.
  return { name: "Authorization", value: "Bearer YOUR_API_KEY" };
}

// A validated public URL never contains a quote/backtick/newline (normalizePublicUrl
// rejects credentials and percent-encodes the rest), but guard anyway so a snippet
// string can never break out of its quoting.
function isSnippetSafeUrl(url: unknown): url is string {
  return typeof url === "string" && url.length > 0 && !/['"`\\\s]/.test(url);
}

function isCredentialSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "wss:";
  } catch {
    return false;
  }
}

function encodeQueryCredentialPart(value: string): string | null {
  try {
    return encodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export interface ServiceSnippets {
  curl: string;
  python: string;
  typescript: string;
}

// Returns { curl, python, typescript } or null when there is no usable base_url.
export function generateServiceSnippets(
  service: Record<string, unknown> | null | undefined,
): ServiceSnippets | null {
  const url = service?.base_url;
  if (!isSnippetSafeUrl(url)) return null;
  // Prefer the structured auth detail; fall back to the scheme-type guess only
  // when no structured detail is present at all. A structured detail is
  // authoritative — including an explicit scheme:"none" (→ no credential). Auth
  // is only ever attached over a credential-safe (https/wss) transport.
  const hasStructuredAuth = service?.auth && typeof service.auth === "object";
  const auth: AuthCredential | null = !isCredentialSafeUrl(url)
    ? null
    : hasStructuredAuth
      ? authFromDetail(service.auth)
      : service?.auth_required
        ? {
            location: "header",
            ...authHeaderForSchemes(service?.auth_schemes),
          }
        : null;

  // Header credentials go in the request headers; query credentials go on the URL.
  // Percent-encode the credential name/value: authFromDetail intentionally allows
  // spaces and URL-reserved chars (fine inside a header), but unencoded they'd
  // either trip isSnippetSafeUrl's whitespace guard (→ no snippets at all) or
  // corrupt the query string.
  let requestUrl = url;
  if (auth?.location === "query") {
    const encodedName = encodeQueryCredentialPart(auth.name);
    const encodedValue = encodeQueryCredentialPart(auth.value);
    if (encodedName !== null && encodedValue !== null) {
      requestUrl = `${url}${url.includes("?") ? "&" : "?"}${encodedName}=${encodedValue}`;
    }
  }
  if (!isSnippetSafeUrl(requestUrl)) return null;
  // Header credentials pass through as-is; a cookie credential is sent via the
  // Cookie request header as `name=value` (name/value already quote-safe from
  // authFromDetail). Query credentials are already on requestUrl, not a header.
  const header =
    auth?.location === "header"
      ? auth
      : auth?.location === "cookie"
        ? { name: "Cookie", value: `${auth.name}=${auth.value}` }
        : null;

  const curl = header
    ? `curl -sS '${requestUrl}' \\\n  -H '${header.name}: ${header.value}'`
    : `curl -sS '${requestUrl}'`;

  const pythonHeaders = header
    ? `, headers={"${header.name}": "${header.value}"}`
    : "";
  const python = [
    "import requests",
    "",
    `resp = requests.get("${requestUrl}"${pythonHeaders})`,
    "resp.raise_for_status()",
    "print(resp.json())",
  ].join("\n");

  const typescript = header
    ? [
        `const resp = await fetch("${requestUrl}", {`,
        `  headers: { "${header.name}": "${header.value}" },`,
        "});",
        "if (!resp.ok) throw new Error(`HTTP ${resp.status}`);",
        "const data = await resp.json();",
      ].join("\n")
    : [
        `const resp = await fetch("${requestUrl}");`,
        "if (!resp.ok) throw new Error(`HTTP ${resp.status}`);",
        "const data = await resp.json();",
      ].join("\n");

  return { curl, python, typescript };
}
