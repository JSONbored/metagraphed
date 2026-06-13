# Apex (`metagraph.sh`) agent-discovery runbook

All machine/agent-discovery surfaces are served by the **API Worker** at
`api.metagraph.sh` (this repo): `/`, `/.well-known/*` (api-catalog, agent-skills,
mcp/server-card, mcp.json, llms.txt), `/sitemap.xml`, `/robots.txt`, `/llms.txt`,
`/llms-full.txt`, `/auth.md`, `/agent.md`, RFC 8288 `Link` headers, and the MCP
endpoint `POST /mcp`. These are live and verified.

The **apex** `metagraph.sh` is the human web app (the separate `metagraphed-ui`
Lovable repo). Agent-readiness scanners (e.g. isitagentready.com) probe the apex
and find none of the discovery surfaces there. This runbook makes the apex pass
**without** duplicating anything into the UI repo — everything is Cloudflare-zone
config on `metagraph.sh`, so there is a single source of truth (the Worker).

> None of this is deployable from this repo — it is dashboard / Terraform config
> on the `metagraph.sh` zone. Apply it yourself, or authorize the Cloudflare MCP
> and it can be set up directly.

## 1. Proxy the discovery paths to the API (recommended: Snippet)

A Cloudflare **Snippet** on the `metagraph.sh` zone that reverse-proxies the
discovery paths to `api.metagraph.sh` (serving the content under the apex, so a
scanner that does not follow cross-host redirects still sees it):

```js
// Snippet: apex-discovery-proxy
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upstream = new URL(
      url.pathname + url.search,
      "https://api.metagraph.sh",
    );
    const resp = await fetch(upstream, request);
    // Preserve the API's Link/Content-Type headers; surface the proxy origin.
    const headers = new Headers(resp.headers);
    headers.set("x-served-by", "api.metagraph.sh");
    return new Response(resp.body, { status: resp.status, headers });
  },
};
```

Bind it with a **Snippet Rule** that matches the discovery paths only (so the UI
keeps serving everything else):

```
(http.request.uri.path in {"/sitemap.xml" "/robots.txt" "/llms.txt" "/llms-full.txt" "/auth.md" "/agent.md"}
 or starts_with(http.request.uri.path, "/.well-known/"))
```

**Simpler alternative — Redirect Rules** (no Snippet; dashboard-only): a dynamic
redirect for the same expression to `https://api.metagraph.sh${http.request.uri.path}`
(302). Use only if the scanner follows cross-host redirects; the Snippet proxy is
more robust.

## 2. Add `Link` headers to the apex homepage

A Cloudflare **Response Header Transform Rule** on `metagraph.sh`, matching
`http.request.uri.path eq "/"`, that **sets** the `Link` header:

```
</.well-known/api-catalog>; rel="api-catalog", </llms.txt>; rel="service-doc", </metagraph/openapi.json>; rel="service-desc"
```

(The proxy in step 1 makes `metagraph.sh/.well-known/api-catalog` resolve.)

## 3. Relax the apex AI-bot block (optional, policy decision)

The apex `robots.txt` is Cloudflare **Managed robots.txt** and currently sets
`Content-Signal: ai-train=no` and `Disallow: /` for `ClaudeBot`, `GPTBot`,
`Google-Extended`, etc. If you want agents to crawl the human app, relax this in
the Cloudflare **AI Audit / Managed robots.txt** settings. (The API host stays
open regardless — its `robots.txt` is `Allow: /`.)

## 4. Verify

Re-run the scanner against `https://metagraph.sh` (and `https://api.metagraph.sh`,
which already passes). The api-catalog / agent-skills / MCP-card / Link-header /
sitemap / auth.md checks should pass via the proxy; OAuth/OIDC and protected-
resource remain N/A by design (the API is public + unauthenticated — see
[`/auth.md`](https://api.metagraph.sh/auth.md)).
