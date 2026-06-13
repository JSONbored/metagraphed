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
Link: <https://api.metagraph.sh/.well-known/api-catalog>; rel="api-catalog", <https://api.metagraph.sh/metagraph/openapi.json>; rel="service-desc"; type="application/json", <https://api.metagraph.sh/llms.txt>; rel="service-doc"; type="text/plain", <https://api.metagraph.sh/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"
```

That worker also independently proxies the discovery resources + builds the
sitemap as a self-contained fallback (so apex discovery survives even if these
backend routes are ever removed); the backend routes above win for the paths
they cover, so the backend is the live source for everything except `/` and
`/sitemap.xml`.

## Optional: AI-bot crawl policy

The apex `robots.txt` is Cloudflare **Managed robots.txt** and currently
`Disallow: /` for `ClaudeBot`/`GPTBot`/etc. with `Content-Signal: ai-train=no`.
Relax it in the Cloudflare AI-Audit / Managed-robots settings if you want agents
to crawl the human app. (The API host stays open regardless — `Allow: /`.)
