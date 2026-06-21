# Metagraphed Prod/Beta Roadmap

This document captures the strategic direction and the sequenced work to take
Metagraphed from its current state to a public beta. It is a planning artifact;
health, latency, completeness, and pool eligibility remain probe-/build-derived
only, exactly as in `docs/operations.md`.

## Context

Metagraphed is an unofficial operational registry for Bittensor subnet
interfaces, health, schemas, and access metadata — the builder-facing layer the
native metagraph lacks. The backend is schema-driven and deterministic
(JSON Schema → OpenAPI → TS types → client are all generated), uses tiered
storage (Git + Cloudflare R2 + KV) served by one Worker, is safety-bounded
(read-only probes, no credentials, gated UGC), and already covers all active
Finney netuids with adapter-backed pilots for Allways (SN7) and Gittensor (SN74).

Goals driving this roadmap:

1. Reach a credible public beta quickly.
2. Refocus on a defensible edge.
3. Strengthen the project as a candidate for gittensor emission-weighting — a
   polished public good that measurably serves the Bittensor subnet ecosystem.

Locked decisions:

- **Edge / moat:** coverage completeness, framed as _trustworthy, verified_
  completeness.
- **Frontend:** `jsonbored/metagraphed-ui` (Lovable-owned) stays a **separate
  Cloudflare Worker** from the backend.
- **Beta differentiator:** enable the read-only RPC proxy (with Cloudflare WAF +
  rate limiting as prerequisites).

## Strategic Edge: Trustworthy Coverage Completeness

The headline differentiator is complete, verifiable, machine-readable coverage of
every Bittensor subnet's public builder interfaces — and the ability to _prove_
that completeness with provenance and live freshness. Existing dashboards
(taostats, taomarketcap, backprop, subnetradar) publish alpha/price/validator
analytics; the native metagraph publishes protocol state. None publish a
complete, verifiable builder-interface + health registry with a completeness
metric.

Completeness is only defensible if it is trustworthy, so the other product layers
are supporting pillars of the completeness story rather than separate bets:

- **Completeness** — the headline metric and public scoreboard.
- **Provenance** (evidence ledger) — proof the completeness is real, not asserted.
- **Freshness + health** — proof the completeness is current, not stale.
- **Adapter depth** (Gittensor / Allways) — the reference of what "complete" looks like.

The project should also be an exemplary, healthy, gittensor-registered repo, and
its Gittensor/Allways adapters should be pristine — they are the highest-traffic
subnets and demonstrate the product to the broader ecosystem.

## Findings (prioritized)

### P0 — Truth and data quality

1. **Gittensor (SN74) adapter ships degraded data (operational, not a code bug).**
   `registry/adapters/latest/gittensor.json` currently shows `Bad credentials`
   (401), all 18 repos at `html-fallback` with `null` `pushed_at`/`open_issues_count`,
   and `captured_count: 0` — committed from a local, tokenless, epoch-stamped run.
   The snapshot code is already hardened: `scripts/snapshot-adapters.mjs` reads
   `GITHUB_TOKEN`/`GH_TOKEN`, warns and carries forward on 401, and honors
   `METAGRAPH_REQUIRE_ADAPTER_AUTH=1` to fail closed — and `sync-subnets.yml`
   already sets that guard and passes the token. Remaining work is **operational**:
   regenerate the committed adapter via a successful tokened sync run so real
   repository metadata ships. Note `publish-cloudflare.yml` does not re-snapshot
   adapters; it publishes whatever is committed, so a guard there (or a validator
   that rejects an all-`html-fallback` adapter) is the optional belt-and-suspenders.
   _Update:_ that validator now exists — `npm run validate:adapters`
   (`scripts/validate-adapters.mjs`) flags broken-auth / all-`html-fallback`
   adapters; it warns on ordinary PRs and fails closed under
   `METAGRAPH_PRODUCTION_BUILD` / `METAGRAPH_REQUIRE_ADAPTER_AUTH`, and is wired
   into the `publish-cloudflare.yml` refresh job and `sync-subnets.yml` so degraded
   adapter data cannot ship. Regenerating the committed snapshot via a tokened sync
   run remains the operational follow-up.
2. **Epoch-zero timestamps in published artifacts.** _Done._ Builds stamp
   `1970-01-01T00:00:00.000Z` into `generated_at` via `buildTimestamp()`
   deliberately — byte-identical artifacts let R2 delta-upload skip unchanged
   files — so `generated_at` stays a deterministic content marker. A real
   `published_at` now rides alongside it: `lib.publishedAt()` reads
   `METAGRAPH_PUBLISHED_AT` (set by `publish-cloudflare.yml`), `build-summary.json`
   carries it (it is excluded from the artifact digest set, so hashing/changelog
   are untouched), the KV pointer (`metagraph:latest`) carries it, and the Worker
   surfaces it as envelope `meta.published_at`. The pointer read happens only on
   origin misses (the `/api/v1` routes are edge-cached), so it is not a per-user
   hot-path cost; it is typed in `ResponseMeta`/`BuildSummaryArtifact` for the UI.

### P1 — Beta launch readiness

3. **Prove the live API end-to-end.** _Re-architected (see `docs/adr/0001`)._
   The deploy pipeline was decoupled: **Worker code deploys via Cloudflare
   Workers Builds on every push to `main`** (connected; native R2/KV/deploy creds,
   no GitHub secrets; `wrangler.jsonc` carries 100% logs+traces + Smart
   Placement), and **data refreshes on an event-driven publish** (on each
   human-input registry merge + a daily floor — see `docs/adr/0007`;
   `publish-cloudflare.yml`: build → validate → `r2:upload` + `kv:publish` →
   `smoke:live`).
   _Remaining verification:_ dispatch the scheduled data-refresh once
   (`workflow_dispatch publish_mode=publish`) to confirm the real `r2:upload`/
   `kv:publish`/`smoke` path end-to-end.
4. **Ship a frontend integration handoff.** `generated/metagraphed-client.ts`,
   `generated/metagraphed-api.d.ts`, and `openapi.json` exist but are not packaged
   or documented for the UI team: envelope shape (`ok`/`schema_version`/`data`/
   `meta`/`error`), pagination/sort/filter semantics (already implemented in
   `workers/api.mjs`), cache profiles, error codes, `x-metagraph-*` headers, and
   stability guarantees.
5. **Two-Worker routing is a real config change.** `wrangler.jsonc` uses
   `custom_domain: true`, which binds the entire apex to one Worker (see
   architecture section).
6. **Versioning hygiene.** _Done:_ `package.json` set to `0.1.0-beta.0` (nothing
   embeds the package version into artifacts, so this is artifact-neutral). The
   `CONTRACT_VERSION` date scheme stays; the `/api/v1` stability contract is now
   documented in `docs/api-stability.md`.

### P1/P2 — RPC proxy (beta differentiator)

7. **Read-only Subtensor RPC proxy — SHIPPED + LIVE** (`METAGRAPH_ENABLE_RPC_PROXY:
"true"`). `handleRpcProxyRequest` enforces the method allowlist, denied prefixes,
   body cap, SSRF guards, trusted upstream origins, weighted-random **load balancing**
   across eligible+safe endpoints, and an in-Worker **rate limiter** (`RPC_RATE_LIMITER`,
   100 req/60s per IP); the probe-derived pool is published + health-overlaid
   (hysteresis #594 + genesis chain-verification #596/#604). Verified in production:
   `system_health`/`chain_getHeader` → `200` JSON-RPC result; `author_submitExtrinsic`
   → `rpc_method_blocked`; pools finney-rpc 4/5, finney-wss 4/4, finney-archive 8/8
   eligible. Cloudflare WAF on `/rpc/*` + the flag are in place (see the runbook in
   `docs/operations.md`). This is the hosted-infra feature that separates Metagraphed
   from a pure-registry product.

### P2 — Performance and scale

8. **Monolithic artifacts are heavy for a browser.** `surfaces.json` (~1.1MB),
   `evidence-ledger.json` (~858KB), `search.json` (~659KB), and `profiles.json`
   (~605KB) are served whole. Rely on the Worker's existing pagination/filter
   layer for list routes, prefer per-subnet detail routes in the UI, confirm
   Cloudflare brotli/gzip plus the ETag and `stale-while-revalidate` already set,
   and consider a slimmer search-index payload.
9. **KV pointer / rollback discipline.** Confirm `metagraph:latest` is published
   each run so the Worker reads versioned R2 rather than only `latest/`; the
   pointer-first rollback is documented in `docs/operations.md`. _Added:_ `GET
/health` is now freshness-aware — it reads the pointer's `published_at` and
   returns `degraded` + HTTP 503 past `METAGRAPH_HEALTH_MAX_AGE_HOURS` (default 48),
   so an uptime monitor catches a silently-broken data-refresh.

### P2/P3 — Coverage-completeness flywheel (the moat, made visible)

10. **First-class, documented completeness score.** _Done._ `coverage.json`
    (`/api/v1/coverage`) now carries a `completeness` aggregate — scored count,
    average/median, fully-complete count, a score histogram, per-dimension
    coverage, and a methodology pointer — promoted from the internal review
    queue and typed in `CoverageArtifact`. **Freshness auto-demotion** now feeds
    the score: an operational surface not probed healthy within
    `METAGRAPH_FRESHNESS_STALE_AFTER_DAYS` (default 7) of the probe run contributes
    half its points and is flagged `stale-<kind>` in `gap_reasons`, so "complete"
    tracks _current_ liveness. It is computed from captured probe timestamps (no
    wall-clock), so committed artifacts stay byte-stable and the demotion only
    manifests in probe-backed production refreshes.
11. **Public coverage leaderboard / "what's missing" view.** _Mostly done:_ the
    per-subnet leaderboard is queryable at
    `/api/v1/profiles?sort=completeness_score&order=asc` and the gaps live in
    `gap-priorities.json`/`enrichment-queue.json`. Remaining is the UI rendering
    (frontend repo).
12. **README health/coverage SVG badges.** _Done._ The Worker serves a
    self-hosted SVG at `/metagraph/health/badges/{netuid}.svg` (rendered from the
    badge JSON, no shields.io dependency); embedding documented in the README.
13. **Community completeness flywheel.** The one-file PR / issue intake already
    exists; surface "you can fill this gap" calls to action so coverage improves
    through contributions, not only maintainer effort.
14. **Adapter showcase.** Keep Gittensor (SN74) and Allways (SN7) adapters
    pristine and expand their public dimensions as the reference for "complete."

## Frontend Architecture: Two Separate Cloudflare Workers

Current state: the `metagraphed` Worker binds the whole apex via
`custom_domain: true` and serves the SPA/static itself through the `ASSETS`
binding (`run_worker_first` only for `/api/*`, `/rpc/*`, `/metagraph/*`). A custom
domain routes all hostname traffic to a single Worker, so a second Worker cannot
share the apex while `custom_domain` is set.

Recommended model — same apex, path-routed via zone routes (no CORS, matches the
README's `metagraph.sh/subnets/7` + `metagraph.sh/metagraph/subnets.json`
examples):

- **Backend Worker (`metagraphed`)** — switch from `custom_domain: true` to zone
  route patterns `metagraph.sh/api/*`, `metagraph.sh/metagraph/*`,
  `metagraph.sh/rpc/*`. Keep the `ASSETS` binding only for the compact
  `public/metagraph/*` artifacts. Drop SPA-serving responsibility.
- **Frontend Worker (`metagraphed-ui`)** — its own `wrangler` project, route
  `metagraph.sh/*` (catch-all, lowest precedence). Serves the SPA; its API base
  URL is same-origin `/api/v1`, so no CORS and no cross-origin cookies.
- Cloudflare matches more-specific routes first, so `/api/*` and friends hit the
  backend and everything else falls through to the UI.

Simpler fallback (subdomain split): backend on `api.metagraph.sh`
(`custom_domain`), UI on `metagraph.sh`, relying on the Worker's existing
permissive CORS. Offer only if zone-route management is undesirable.

Handoff kit for the UI team: a published, versioned `openapi.json`; the generated
`.d.ts` + client (optionally an npm package later); a one-page integration guide
(envelope, pagination, cache, error codes, `x-metagraph-*` headers, stability
guarantees); and a handful of copy-paste example queries against the live beta.

## Roadmap

### Phase 0 — Truth fixes (unblocks a credible beta)

- **Done:** `package.json` → `0.1.0-beta.0`; `/api/v1` stability contract written
  to `docs/api-stability.md` (Finding 6).
- **Done:** serving-layer `published_at` via `lib.publishedAt()` +
  `build-summary.json` + KV pointer + Worker `meta.published_at`, typed in the
  schema; deterministic `generated_at` preserved (Finding 2).
- **Done (code):** adapter snapshot hardened — `GITHUB_TOKEN`/`GH_TOKEN`, 401
  carry-forward, `METAGRAPH_REQUIRE_ADAPTER_AUTH=1` wired in `sync-subnets.yml`
  (Finding 1). **Remaining (ops, needs a CI token):** regenerate the committed
  Gittensor/Allways adapters via a successful tokened sync run.

### Phase 1 — Beta launch

- **Done (Phase 1, self-sufficient publish):** Confirm a green production publish
  and a passing `npm run smoke:live` (Finding 3). _Root cause was the `publish`
  job's `Validate registry` step failing the publish-only freshness gate
  (`adapter-snapshots is stale`), **upstream** of the secret check — not missing
  Cloudflare credentials. The production build now re-snapshots adapters (it
  already re-probes health) so the publish is green by construction; the three
  Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `METAGRAPH_KV_NAMESPACE_ID`) and the "Actions may create PRs" setting are
  configured. Part of the artifact-churn-elimination migration — see
  `docs/adr/0001-r2-only-data-artifacts.md`._
- **Done (worker edge hardening, not in original findings):** `/health` readiness
  probe, time-bounded R2 reads (`r2_timeout` 504), and structured observability
  logging.
- Restructure routing to two Workers via zone routes; coordinate the
  `metagraphed-ui` Worker project (architecture section). _Gated:_ needs the
  frontend Worker deployed + DNS/zone-route changes, so the `wrangler.jsonc`
  `custom_domain` switch is intentionally not yet applied (it would orphan the
  apex until the UI Worker exists).
- **Done:** frontend handoff kit — `docs/api-stability.md` (envelope, pagination,
  cache, headers, error codes, `published_at`, versioning, example queries) plus
  the generated `openapi.json`/`.d.ts`/client and a README pointer (Finding 4).
  _Open coordination:_ whether to also publish an npm package.
- Performance pass: confirm compression and lean the heavy list payloads for
  browser use (Finding 8).

### Phase 2 — RPC proxy differentiator (parallelizable)

- Generate and publish probe-derived `rpc/pools.json` with eligible endpoints;
  configure Cloudflare WAF + Rate Limiting; expand the safe read method set; flip
  `METAGRAPH_ENABLE_RPC_PROXY=true`; live smoke (Finding 7).

### Phase 3 — Coverage-completeness flywheel (post-launch, ongoing)

- **Done:** publish the completeness score + methodology in `coverage.json`
  (Finding 10).
- **Done:** self-hosted README/coverage SVG badges (Finding 12).
- Leaderboard/"what's missing" hero view (Finding 11) — data is queryable; UI
  rendering is frontend work.
- Community gap-fill CTAs (Finding 13) and adapter expansion (Finding 14).
- **Recommended follow-up (not yet done):** close the freshness loop — auto-flag
  and demote surfaces not probed healthy within N days, so "complete" can never
  drift to "complete but stale/dead." Touches `probes-smoke.mjs` →
  `curate-baseline.mjs`/`build-artifacts.mjs`.

## Verification

- **Adapter fix:** re-run `npm run adapters:snapshot` with a valid token; assert
  `gittensor.json` has `captured_count > 0`, real `pushed_at`, and no
  `Bad credentials`.
- **Timestamps:** assert published artifacts carry a non-epoch `published_at`
  while the deterministic build stays reproducible across rebuilds.
- **Pipeline integrity:** `npm run check`, `npm test` (coverage gate), and
  `npm run pipeline:check` stay green.
- **Live beta:** `npm run smoke:live` covers envelopes, CORS, ETag/304,
  R2-fallback routes, invalid-query 400s, and the RPC contract.
- **Routing split:** both Workers resolve on `metagraph.sh` (UI at `/`, API at
  `/api/v1`, artifacts at `/metagraph/*`) with same-origin fetches and no CORS
  errors.
- **RPC proxy:** with the flag on, allowed read methods proxy through an eligible
  pool endpoint while denied/write methods return 403; with the flag off the proxy
  returns `rpc_proxy_disabled`.
- **Frontend handoff:** the UI team can generate a typed client from the published
  OpenAPI and render the coverage/leaderboard artifacts against the live beta.

## Open coordination items (not blockers)

- Confirm the `metagraphed-ui` deploy target (its own Worker project + route).
- Decide whether to publish generated types as an npm package now or hand off
  files for beta.
- Confirm the Cloudflare plan supports the WAF / Rate Limiting rules the RPC proxy
  needs.
