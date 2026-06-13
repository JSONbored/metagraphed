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
metagraph.sh/sitemap.xml
metagraph.sh/llms.txt
metagraph.sh/llms-full.txt
metagraph.sh/auth.md
metagraph.sh/agent.md
```

So `metagraph.sh/.well-known/api-catalog`, `/sitemap.xml`, `/llms.txt`,
`/auth.md`, `/agent.md`, `/.well-known/agent-skills/index.json`, and
`/.well-known/mcp/server-card.json` are all served on the apex by the backend —
**verified live**. The api-catalog references the canonical `api.metagraph.sh`
host, so the apex advertises the real API rather than duplicating it.

## The one remaining piece

The apex **homepage `/` `Link` header** can't live here — `/` must keep serving
the UI (`metagraphed-ui`), so a request to `metagraph.sh/` is handled by that
worker, not this one. To satisfy the "Link headers on homepage" check on the
apex, add to the **`metagraphed-ui`** worker's `/` response:

```
Link: <https://api.metagraph.sh/.well-known/api-catalog>; rel="api-catalog", <https://api.metagraph.sh/llms.txt>; rel="service-doc", <https://api.metagraph.sh/metagraph/openapi.json>; rel="service-desc"
```

(Equivalent alternative, no UI change: a Cloudflare **Response Header Transform
Rule** on `metagraph.sh` matching `http.request.uri.path eq "/"` that sets that
same `Link` header — needs a zone token with `Transform Rules: Edit`.)

## Optional: AI-bot crawl policy

The apex `robots.txt` is Cloudflare **Managed robots.txt** and currently
`Disallow: /` for `ClaudeBot`/`GPTBot`/etc. with `Content-Signal: ai-train=no`.
Relax it in the Cloudflare AI-Audit / Managed-robots settings if you want agents
to crawl the human app. (The API host stays open regardless — `Allow: /`.)
