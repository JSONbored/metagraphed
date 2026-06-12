// Ready-to-run integration snippets (issue #351): given a callable service's
// base_url + declared auth, emit copy-paste curl / Python / TypeScript that does
// a GET against the service — the fastest path to a first successful call.
// Worker-safe (pure string ops, no node deps) so the build generates them once
// into the agent-catalog and the Worker/MCP can regenerate on demand if needed.
//
// We snippet a GET of the surface URL itself (always a valid, documented entry
// point regardless of surface kind); for subnet-api surfaces with a captured
// schema the agent then reads it (get_api_schema) for specific endpoints. The
// auth header is a best-effort placeholder from the declared scheme types — the
// captured spec carries scheme TYPES, not header names, so we use conventions.

function authHeaderForSchemes(schemes) {
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
function isSnippetSafeUrl(url) {
  return typeof url === "string" && url.length > 0 && !/['"`\\\s]/.test(url);
}

// Returns { curl, python, typescript } or null when there is no usable base_url.
export function generateServiceSnippets(service) {
  const url = service?.base_url;
  if (!isSnippetSafeUrl(url)) return null;
  const authHeader = service?.auth_required
    ? authHeaderForSchemes(service?.auth_schemes)
    : null;

  const curl = authHeader
    ? `curl -sS '${url}' \\\n  -H '${authHeader.name}: ${authHeader.value}'`
    : `curl -sS '${url}'`;

  const pythonHeaders = authHeader
    ? `, headers={"${authHeader.name}": "${authHeader.value}"}`
    : "";
  const python = [
    "import requests",
    "",
    `resp = requests.get("${url}"${pythonHeaders})`,
    "resp.raise_for_status()",
    "print(resp.json())",
  ].join("\n");

  const typescript = authHeader
    ? [
        `const resp = await fetch("${url}", {`,
        `  headers: { "${authHeader.name}": "${authHeader.value}" },`,
        "});",
        "if (!resp.ok) throw new Error(`HTTP ${resp.status}`);",
        "const data = await resp.json();",
      ].join("\n")
    : [
        `const resp = await fetch("${url}");`,
        "if (!resp.ok) throw new Error(`HTTP ${resp.status}`);",
        "const data = await resp.json();",
      ].join("\n");

  return { curl, python, typescript };
}
