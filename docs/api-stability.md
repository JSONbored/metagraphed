# Metagraphed API Stability Contract (`/api/v1`)

This is the consumer-facing stability contract for the Worker API served from
`https://api.metagraph.sh/api/v1/*`. It is the reference for the frontend
(`jsonbored/metagraph-finder`) and any external integrator. The canonical machine
contract is `public/metagraph/openapi.json` plus the generated
`generated/metagraphed-api.d.ts` and `generated/metagraphed-client.ts`; this doc
describes the guarantees around them. Behavior here is implemented in
`workers/api.mjs` and `src/contracts.mjs`.

## Response Envelope

Every `/api/v1/*` response is a JSON envelope:

```jsonc
// success
{
  "ok": true,
  "schema_version": 1,
  "data": {
    /* artifact payload, possibly filtered/paginated */
  },
  "meta": {
    "artifact_path": "/metagraph/subnets.json",
    "cache": "standard",
    "contract_version": "2026-06-06.1",
    "generated_at": "1970-01-01T00:00:00.000Z",
    "published_at": "2026-06-09T13:57:16.231Z",
    "source": "static-assets",
    "pagination": {
      /* present on list routes; see below */
    },
  },
}
```

```jsonc
// error
{
  "ok": false,
  "schema_version": 1,
  "data": null,
  "error": { "code": "invalid_query", "message": "..." },
  "meta": { "contract_version": "2026-06-06.1", "artifact_path": "..." },
}
```

Consumers should branch on `ok`. `schema_version` is an integer (currently `1`)
and only changes on a breaking envelope change.

> Note on timestamps: `generated_at` is a deterministic content marker — builds
> default to the epoch (`1970-01-01T00:00:00.000Z`) so byte-identical artifacts let
> R2 delta-upload skip unchanged files. Do not render `generated_at` as a wall
> clock. For human "last updated" display, use `meta.published_at`: the real
> publish time, sourced from the KV latest pointer at the serving layer. It is
> `null` only before the first publish (or when the control KV is unbound).

## Raw Artifact Routes

`https://api.metagraph.sh/metagraph/*.json` returns the raw artifact (no envelope) for
any path in the published artifact contract, with `x-metagraph-artifact-source` and
`x-metagraph-storage-tier` headers. The enveloped `/api/v1/*` routes are preferred
for app consumption; raw routes are convenient for static/diff tooling.

## Status Badges: `/metagraph/health/badges/{netuid}.svg`

`GET …/health/badges/{netuid}.svg` returns a self-hosted shields-style SVG
(`image/svg+xml`, CORS-open, ETag/304) rendered from the badge JSON
(`label`/`message`/`color`). It degrades to a neutral `unavailable` badge (still
`200`) for a subnet without a published badge, so README embeds never break.

## Operational Route: `/health`

`GET https://api.metagraph.sh/health` is a no-I/O readiness probe (not part of the
versioned `/api/v1` contract). It returns `200` with
`{ status, service, contract_version, rpc_proxy_enabled, bindings: { assets, r2,
kv } }` so uptime checks and load balancers can confirm the Worker is live and
which bindings are wired without touching R2/KV.

## Query Semantics (list routes)

List routes accept a stable set of query parameters (validated server-side;
invalid values return `400 invalid_query` with the offending `parameter`):

- `q` — case-insensitive substring search across that route's search keys.
- Field filters — exact match on whitelisted fields (e.g. `?status=active`,
  `?netuid=7`). Enum/integer filters are validated.
- `sort` — one of the route's allowed sort fields; `order` is `asc` (default) or
  `desc`.
- `limit` — integer `1..1000`; pagination engages when `limit` or `cursor` is
  present (default page size `100`).
- `cursor` — non-negative integer offset. The response `meta.pagination` returns
  `total`, `returned`, `limit`, `cursor`, `next_cursor` (null at end), `sort`,
  `order`.

Omitting all paging params returns the full collection (back-compatible).

## Headers

- `access-control-allow-origin: *` (public, read-only). Preflight `OPTIONS`
  supported; methods are `GET, HEAD, OPTIONS` (`POST, OPTIONS` under `/rpc/`).
- `cache-control: public, max-age=<profile>, stale-while-revalidate=300`, where
  the profile is `short` (60s), `standard` (300s), or `static` (600s) per route.
- `etag` (weak) with `if-none-match` → `304` support.
- `x-metagraph-contract-version`, `x-metagraph-cache-profile`,
  `x-content-type-options: nosniff`, `vary: Accept-Encoding`.

## Error Codes

`not_found` (404), `method_not_allowed` (405), `invalid_query` (400),
`r2_binding_missing` (404), `r2_timeout` (504, R2 read exceeded
`METAGRAPH_R2_TIMEOUT_MS`, default 5s), and the RPC proxy codes
(`rpc_proxy_disabled` 501, `rpc_method_blocked` 403, `rpc_endpoint_unavailable`
503, etc.). Errors always carry `error.code` and a human `error.message`.

## Versioning & Stability Guarantees

- **Path version.** `/api/v1` is stable. Breaking changes ship under a new path
  (`/api/v2`); `v1` is not silently mutated.
- **Additive within v1.** New routes, response fields, query filters, and enum
  values may be added without a version bump. Existing fields are not removed or
  retyped, and route semantics are not changed, within `v1`.
- **Contract version.** `CONTRACT_VERSION` (date scheme, e.g. `2026-06-06.1`) is
  surfaced in `meta.contract_version` and the `x-metagraph-contract-version`
  header. `npm run contract:summary` classifies each change as additive, risky, or
  breaking for PR review; `schemas/components/*.schema.json` is the canonical
  source and `openapi.json`/types/client are generated from it.
- **Envelope version.** `schema_version` (integer) bumps only on a breaking
  envelope change.
- **Deprecations.** Announced via `/metagraph/changelog.json` and the contract
  version before removal.

## Recommended Client Usage

- Install the typed client: `npm install @metagraphed/client` (published from
  `packages/client/`, generated from this contract). Example:
  `metagraphedFetch("/api/v1/subnets", { query: { limit: 10 } })`.
- Or generate types/client from the published `openapi.json` (or consume the checked-in
  `generated/metagraphed-*.ts`).
- Send `if-none-match` with stored ETags to get cheap `304`s.
- Prefer per-subnet detail routes (`/api/v1/subnets/{netuid}`) and paginated list
  routes over fetching the largest whole-collection artifacts in the browser.
- Read freshness from `meta.published_at` (real publish time from the serving
  layer), not `generated_at` (a deterministic content marker).

## Example Queries

Copy-paste against the live beta (`https://metagraph.sh`):

```bash
# Registry-wide coverage + the completeness scoreboard (the headline metric)
curl -s https://api.metagraph.sh/api/v1/coverage | jq '.data.completeness'

# Completeness leaderboard — subnets that most need contributions first
curl -s 'https://api.metagraph.sh/api/v1/profiles?sort=completeness_score&order=asc&limit=10' \
  | jq '.data.profiles[] | {netuid, name, completeness_score}'

# One subnet's full profile (identity, surfaces, gaps)
curl -s https://api.metagraph.sh/api/v1/subnets/7/profile | jq '.data'

# Search across the registry
curl -s 'https://api.metagraph.sh/api/v1/search?q=gittensor' | jq '.data'

# Probe-derived health for a subnet + its embeddable badge
curl -s https://api.metagraph.sh/api/v1/subnets/7/health | jq '.data'
#   <img src="https://api.metagraph.sh/metagraph/health/badges/7.svg">

# Worker readiness (not part of /api/v1)
curl -s https://api.metagraph.sh/health | jq
```
