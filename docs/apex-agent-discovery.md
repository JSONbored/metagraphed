# Apex (`metagraph.sh`) agent-discovery

## Architecture

- **`api.metagraph.sh`** — the `metagraphed` backend worker (this repo), a custom
  domain. The canonical agent surface: `/`, `/.well-known/*` (api-catalog,
  agent-skills, mcp/server-card, mcp.json, llms.txt), `/sitemap.xml`,
  `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/auth.md`, `/agent.md`, RFC 8288
  `Link` headers, and `POST /mcp`. Live + verified.
- **`metagraph.sh`** (apex) — the human web app, served by the separate
  `metagraphed-ui` worker (Lovable repo).

## What's implemented (single source of truth)

Rather than redirect/proxy/duplicate, the apex's machine-discovery **paths are
routed to the same backend worker** that serves `api.metagraph.sh`. In this
repo's `wrangler.jsonc`, the `metagraphed` worker holds these `metagraph.sh`
routes (they win over the UI worker's apex domain; `/` and all UI pages stay on
`metagraphed-ui`):

```
metagraph.sh/.well-known/*
metagraph.sh/llms.txt
metagraph.sh/llms-full.txt
metagraph.sh/auth.md
metagraph.sh/agent.md
```

So `metagraph.sh/.well-known/api-catalog`, `/llms.txt`, `/llms-full.txt`,
`/auth.md`, `/agent.md`, `/.well-known/agent-skills/index.json`, and
`/.well-known/mcp/server-card.json` are all served on the apex by the backend —
**verified live**. The api-catalog references the canonical `api.metagraph.sh`
host, so the apex advertises the real API rather than duplicating it.

## Sitemap is host-scoped (NOT routed to the backend)

`metagraph.sh/sitemap.xml` is **not** routed here. A sitemap served at
`metagraph.sh` must list `metagraph.sh` **human pages** (`/`, `/subnets`,
`/providers`, per-subnet pages, …) — crawlers ignore cross-host `<loc>` entries.
The **`metagraphed-ui`** worker builds that human-page sitemap on the apex
(`src/server.ts` → `buildSitemap`). The backend serves its own API/agent sitemap
on its own host at `api.metagraph.sh/sitemap.xml`. (An earlier revision routed
the apex sitemap to the backend, which shadowed the human sitemap with 142
cross-host `api.metagraph.sh` URLs — that route has been removed.)

## Homepage `/` Link header — DONE (in `metagraphed-ui`)

The apex **homepage `/` `Link` header** can't live in this repo — `/` must keep
serving the UI, so `metagraph.sh/` is handled by the `metagraphed-ui` worker. It
is **implemented there and verified live**: `metagraphed-ui/src/server.ts`
(`injectAnalytics`) sets an RFC 8288 `Link` header on every HTML response,
including `/`:

```
Link: <https://api.metagraph.sh/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json", <https://api.metagraph.sh/metagraph/openapi.json>; rel="service-desc"; type="application/json", <https://api.metagraph.sh/llms.txt>; rel="service-doc"; type="text/plain", <https://api.metagraph.sh/agent.md>; rel="service-doc"; type="text/markdown", <https://api.metagraph.sh/health>; rel="status"; type="application/json", <https://api.metagraph.sh/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"
```

The relation set mirrors the authoritative RFC 9264 linkset body served at
`/.well-known/api-catalog` (service-desc, both service-doc targets, status,
describedby), so an agent bootstrapping from the header alone sees the same
entrypoints as the catalog. The backend's `DISCOVERY_LINK_HEADER` (relative
refs) and the apex's (absolute api-origin refs) are kept identical modulo host.

That worker also independently proxies the discovery resources + builds the
sitemap as a self-contained fallback (so apex discovery survives even if these
backend routes are ever removed); the backend routes above win for the paths
they cover, so the backend is the live source for everything except `/` and
`/sitemap.xml`.

## Canonical MCP Registry listing

Beyond the self-hosted surfaces, metagraphed's hosted MCP server is listed in the
canonical [MCP Registry](https://registry.modelcontextprotocol.io) as
`io.github.jsonbored/metagraphed`, pointing at the live `streamable-http` remote
`https://api.metagraph.sh/mcp`. Registry-aware clients can resolve the server by
name; the published listing is `server.json` at the repo root, shipped via GitHub
OIDC (no secret). See [docs/mcp-registry.md](mcp-registry.md).

## Optional: AI-bot crawl policy

The apex `robots.txt` is Cloudflare **Managed robots.txt**: `User-agent: *` is
`Content-Signal: search=yes,ai-train=no` + `Allow: /` (real-time agent fetchers
like `Claude-User`/`ChatGPT-User`/`OAI-SearchBot`/`PerplexityBot` fall through to
`Allow: /`; bulk training crawlers such as `Amazonbot`/`Bytespider` are
`Disallow: /`). This posture is intentional — relax it in the Cloudflare AI
Crawl Control / Managed-robots settings if you want training crawlers in too.
(The API host stays open regardless — `Allow: /`.)

## Audit residuals (owner-only / accepted-cosmetic)

A full live AI-readiness audit (both hosts, every spec) found the stack
spec-conformant; the remaining items below are **not code-fixable from these
repos** or are accepted cosmetic gaps. Recorded here so they are not re-flagged.

- **Apex `robots.txt` has no `Sitemap:` directive.** The file is Cloudflare
  Managed (edge-injected before any Worker runs; GET-only), so the directive
  cannot be added from code. The API host's worker-served `robots.txt` does
  carry its `Sitemap:` line. Per RFC 9309 the directive is optional (crawlers
  still find `/sitemap.xml` by convention / Search Console). To add it: set
  `Sitemap: https://metagraph.sh/sitemap.xml` via the Cloudflare dashboard
  (Managed robots.txt appended content), or disable Managed robots.txt for the
  zone and let the `metagraphed-ui` worker serve `robots.txt` (moves the fix
  into that repo).
- **DNS-AID (DNS-based agent-interface discovery) is unimplemented.** Optional,
  against a non-ratified draft; HTTP discovery (`.well-known/*` + `Link` +
  `llms.txt`) fully covers the requirement, so there is no readiness penalty. To
  add it, create TXT records on the `metagraph.sh` DNS zone (Cloudflare
  dashboard), e.g. `_agent` →
  `v=agent1; catalog=https://api.metagraph.sh/.well-known/api-catalog` and
  `_mcp` → `v=mcp1; endpoint=https://api.metagraph.sh/mcp`.
- **MCP `server-card.json` `published_at` is `null`** on the committed static
  asset (its `generated_at` is the deterministic 1970 epoch content marker by
  design). The publish workflow stamps a real `published_at` only into R2/KV,
  but Workers Builds ships the committed (unstamped) tree, so the field can
  never be truthfully populated for code-deployed assets. Impact is low — agents
  get freshness/integrity from `version` (the contract version), `content_hash`,
  and the HTTP `etag`. Left as-is rather than churn the build to populate a field
  that is structurally unpopulatable for static assets.
