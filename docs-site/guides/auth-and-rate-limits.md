---
title: Auth & rate limits
description: Public read-only API guarantees, caching, and client expectations.
---

# Auth & rate limits

The Metagraphed Worker API at `https://api.metagraph.sh` is **public and read-only** for registry consumption. No API key is required for `/api/v1/*` GET routes, artifact downloads under `/metagraph/*`, MCP, or the agent indexes.

## Authentication

| Surface                                   | Auth                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `/api/v1/*` (GET)                         | None                                                 |
| `/metagraph/*.json`                       | None                                                 |
| `/mcp`                                    | None (read-only tools)                               |
| `/rpc/v1/*`                               | May be disabled or rate-limited; see route responses |
| Subnet third-party APIs (in the registry) | Per-surface — check `auth_required` on each surface  |

When a registered subnet API requires credentials, Metagraphed records that fact (`auth_required: true`) but **never stores secrets**. Use placeholder auth shapes only in docs (`Bearer <token>`).

## Rate limits

Cloudflare WAF and rate limiting protect the production Worker. Integrators should:

- Prefer **paginated** list routes (`limit`, `cursor`) over downloading whole-collection artifacts in the browser
- Send **`If-None-Match`** with cached ETags for cheap `304` responses
- Use **`meta.published_at`** for human freshness display — not `generated_at` (a deterministic content marker)
- Pace calls to third-party subnet APIs using optional structured `rate_limit` metadata on surfaces when present

Metagraphed does **not** enforce subnet-published rate limits — those are integration hints for your client.

## Response envelope

```jsonc
{ "ok": true, "schema_version": 1, "data": { /* payload */ }, "meta": { /* cache, pagination */ } }
{ "ok": false, "error": { "code": "invalid_query", "message": "..." }, "meta": { /* ... */ } }
```

Common error codes: `not_found` (404), `invalid_query` (400), `method_not_allowed` (405), `r2_timeout` (504).

## CORS & caching

- `access-control-allow-origin: *` on public routes
- `cache-control: public, max-age=<profile>, stale-while-revalidate=300` (`short` 60s · `standard` 300s · `static` 600s)
- `x-metagraph-contract-version` header tracks the contract date stamp

## Stability

- Path version `/api/v1` is stable; breaking changes ship under `/api/v2`
- Additive changes (new fields, routes, enum values) do not bump the path version
- Deprecations are announced in [`/metagraph/changelog.json`](https://api.metagraph.sh/metagraph/changelog.json)

Deep reference: [`docs/api-stability.md`](https://github.com/JSONbored/metagraphed/blob/main/docs/api-stability.md).
