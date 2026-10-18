# Catalog pagination consistency

Collection `cursor` remains a numeric row offset. Existing REST, MCP and client
requests keep their current behavior. An offset alone is not stable across
changes: `[a,b,c,d]` returns `[a,b]` at limit 2; removing `a` makes offset 2
return `[d]`, skipping `c`. Inserting a row before the offset can repeat `b`.

REST collection routes offer optional checked paging:

1. Start with `?limit=100&page_snapshot=start` at cursor 0 (or omit cursor).
2. Follow the returned RFC 8288 Link URLs, or echo `meta.pagination.snapshot`
   as `page_snapshot` alongside the numeric `next_cursor`.
3. A mismatched snapshot returns the existing `400 invalid_query` error with
   parameter `page_snapshot`. Restart at cursor 0 using the same search,
   filters, sort and projection; do not append that new first page to old rows.

The versioned `v1.<sha256>` identity binds the full filtered, ordered rows before
projection, their collection/public path and active query scope. Parameter and
object-key ordering do not matter; representation (`format`), page size and
numeric offset do not change the dataset identity. A resolved incident window
and public network path remain part of the scope. Hidden projected-field
changes and live-health changes can invalidate a walk too. Duplicate sort
values need no guessed unique key: unchanged ordered rows retain their order;
a tied-row reorder changes their digest. Invalid token versions and malformed
continuation offsets are rejected rather than treated as the first page.

This is a consistency check, not a retained frozen snapshot, a keyset cursor,
an authorization token, or a guarantee of progress while data keeps changing.
It identifies content, not a certified publication or chain-capture pass;
identical content can reproduce the same digest after an intervening change.
The server retains no snapshot; any matching-row mutation can require a restart.
Checked requests bypass ordinary static/overlay/analytics page caches and return
`Cache-Control: no-store`. The current effective rows are validated on every
request, including unchanged publication or health stamps with changed row values.
Legacy cache keys, behavior and numeric offsets remain unchanged.

The additive REST parameter and optional metadata field preserve existing
numeric cursor types and unguarded responses. Eight MCP tools expose the same
optional `page_snapshot` control and return `snapshot` beside `next_cursor`:
`list_endpoints`, `list_rpc_endpoints`, `list_provider_endpoints`,
`get_subnet_endpoints`, `list_subnet_endpoints`, `list_surfaces`,
`get_subnet_surfaces` and `list_subnet_surfaces`. Their checked identity uses the
canonical mainnet REST route and validated provider/netuid subject, including Root 0.
Other MCP collections and GraphQL retain legacy offsets without this guarantee.

REST failures retain `400 invalid_query` and `meta.parameter`; the additive
`meta.catalog_paging.reason` distinguishes `catalog_changed`,
`catalog_budget_exceeded` and `catalog_unavailable`. MCP structured errors carry
`parameter`, `catalog_paging` and respectively `catalog_restart_required`,
`catalog_budget_exceeded` or `artifact_unavailable`. Invalid inputs remain
`invalid_params`. SDK errors preserve the envelope and use these same typed codes.

The endpoint, API catalog and provider views opt in through their shared
infinite-query helper. A mismatch stops continuation without automatic retries.
Restart results cancels pending pages and requests exactly one fresh first page
with the same filters. It replaces accepted rows atomically only on success.
Continuation/restart failure retains accepted rows and their counts with an
explicit freshness-unverified notice. Recovery remains keyboard/touch accessible;
continuation is unavailable during replacement. Late responses cannot append to
the new query generation. Each continuation preserves the first snapshot and total.

The TypeScript and Python sync/async SDK iterators validate checked receipts, totals, row counts and
cursor progress before yielding, and forward the version with the offset. They
copy caller options. `fetchAll` / `fetch_all` throw on a failed walk rather than returning
partial rows. Checked SDK requests bypass ETag caches and implicit transport/status
retries, including bodyless 304 recovery; legacy SDK behavior is preserved.

Those tables' CSV action starts a fresh checked walk and downloads only after
it completes. It preserves filters, shown columns and client sorting. Changed
results, network switches, navigation or view changes cancel the attempt rather
than emit a partial file. Exports are bounded to 50 pages, 50,000 rows and 16 MiB
of row JSON; users can narrow filters after a limit error. Provider probe columns
still merge separately cached endpoint evidence: the guard certifies the catalog
row walk, not one atomic capture spanning both sources.

The canonical writer streams the existing v1 encoding, bounding checked work to
**5,000 matched rows**, **16,777,216 canonical UTF-8 bytes** (query identity,
complete ordered rows and newline separators), and **64 nested levels** (root
level zero). These inclusive limits are declared once in `src/route-limits.ts`.
Row count is checked before sorting. Strings are escaped in bounded chunks with
surrogate pairs preserved; exhaustion returns no digest or partial page. Over-budget
errors tell callers to narrow filters. Projections and smaller page sizes cannot
hide oversized effective results. The limits bound hashing/checked matching rows,
not the pre-existing artifact download, parsing or filtering cost. They introduce
no history/database read and claim no production CPU or peak-heap guarantee.

Native exact-bound/worst-case fixtures and required schema, parity, route,
coverage and UI/browser checks qualify this source. Regenerate contracts using
the existing native pipeline; never hand-edit generated output. Separate API/UI
deployment receipts remain necessary before issue closure.

## Applicable feeds and transport boundaries

The canonical `API_QUERY_COLLECTIONS` and published `api-index.json` identify
38 REST entries across 29 collections. OpenAPI additionally expands the subnet
and economics network templates, yielding 40 templates with `page_snapshot`.
The shared collection engine owns all of these; small subnet/provider views do
not acquire a separate paging protocol.

| Collection              | REST paths after `/api/v1/`                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `adapter-candidates`    | `review/adapter-candidates`                                                              |
| `agent-catalog`         | `agent-catalog`                                                                          |
| `candidates`            | `candidates`, `subnets/{netuid}/candidates`                                              |
| `claims`                | `evidence`, `subnets/{netuid}/evidence`                                                  |
| `contracts`             | `contracts`                                                                              |
| `coverage-depth`        | `coverage-depth`                                                                         |
| `curated-surfaces`      | `surfaces`, `subnets/{netuid}/surfaces`                                                  |
| `curation`              | `curation`                                                                               |
| `documents`             | `search`, `search-index`                                                                 |
| `economics`             | `economics`                                                                              |
| `endpoint-incidents`    | `endpoint-incidents`                                                                     |
| `endpoint-pools`        | `endpoint-pools`                                                                         |
| `endpoints`             | `endpoints`, `subnets/{netuid}/endpoints`, `providers/{slug}/endpoints`, `rpc/endpoints` |
| `enrichment-evidence`   | `review/enrichment-evidence`                                                             |
| `enrichment-queue`      | `review/enrichment-queue`                                                                |
| `enrichment-targets`    | `review/enrichment-targets`                                                              |
| `fixtures`              | `fixtures`                                                                               |
| `gaps`                  | `gaps`                                                                                   |
| `health-subnets`        | `health`                                                                                 |
| `health-surfaces`       | `health/history/{date}`, `subnets/{netuid}/health`                                       |
| `incidents`             | `incidents`                                                                              |
| `profile-completeness`  | `review/profile-completeness`                                                            |
| `profiles`              | `profiles`                                                                               |
| `providers`             | `providers`                                                                              |
| `review-gap-priorities` | `review/gaps`, `subnets/{netuid}/gaps`                                                   |
| `rpc-pools`             | `rpc/pools`                                                                              |
| `sources`               | `source-snapshots`                                                                       |
| `subnet-trajectory`     | `subnets/{netuid}/trajectory`                                                            |
| `subnets`               | `subnets`                                                                                |

Economics, health, dated health history, trajectory, endpoint/pool/incidents
and RPC views contain observations or serve-time overlays. Their token binds
served matching rows; it does not certify a finalized capture or one atomic
observation across sources. A global stamp outside those rows can change while
the token remains valid. There is no time-based token lease; checked requests
revalidate the effective result rather than accepting a cached page. Changing
or reverting source content can reproduce an earlier digest.

MCP has 33 shared-pager calls across 31 modules, including the generic inline
pagers in `mcp-server.ts`. Manual `list_subnets`, `search_subnets` and
`find_subnets_by_capability` retain their offsets; `applySubnetListQuery` also
pages snapshot, health, trajectory, endpoint/candidate/evidence/surface,
fixture, freshness, agent-catalog and coverage-depth views. These transports
preserve legacy behavior. Only the eight explicitly classified endpoint/surface
tools above offer checked walks; other tools make no such guarantee. The capped
`list_enrichment_targets` recommendation is not a continuation feed; the
separate `list_review_enrichment_targets` catalog is. GraphQL collection and
nested-list offsets likewise do not advertise the REST snapshot control.

`search_tools` already uses its own bounded deployment/query/offset cursor.
Blocks, extrinsics, chain/account events, transfers, identity histories, sudo,
governance and subnet hyperparameter histories retain their separate opaque or
keyset/history-reader contracts. A matching count or final cursor alone does
not establish complete or finalized historical coverage.

## Finite native evidence

`tests/health-overlay-cache.test.ts` drives the real router and existing cache
with finite local artifact/KV sources. It emits `CATALOG_WALK_FIXTURE` receipts
for 1,200 producer-shaped endpoints and 160 schema-checked providers, 200-row
pages, three alternating-order samples, legacy and guarded walks, and cold
versus immediately warm cache. Returned IDs must exactly equal the fixture
population; warmed legacy walks must avoid artifact reads, while every checked
page must re-read its artifact and must not populate the page cache. Source bytes, response
bytes, page counts, cache entries, wall time, process CPU, heap/RSS baselines,
sampled increases/high-water values and heap deltas are recorded. Timing and
memory never decide pass/fail.

`CATALOG_CHURN_FIXTURE` cases change rows after page one. A legacy walk can
finish with the expected count while skipping a fresh row. Guarded continuation
must reject, discard the incomplete result and complete a fresh walk after the
single change. Two explicitly bounded attempts under persistent observation
changes must both reject; no automatic retry or eventual-progress claim is
made. The browser case in `endpoint-search-state.spec.ts` exercises the same
snapshot rejection, then refresh, unchanged search/filter intent and fresh-only
rows/counts. Its shared fixture uses the actual collection engine and the
router's `meta.parameter` error-envelope shape.

These are native Node/Chromium fixture measurements, not production Workers
performance. R2/KV network latency is absent; local JSON parsing is included.
The Map cache does not model TTL expiry, colos, eviction or eventual consistency.
Process CPU includes other process work, CI coverage/GC affect observations,
and between-page heap/RSS samples can miss allocation peaks. Repeated cold
pages still verify the complete matching content; legacy warm URL hits use the
existing cache. Checked warm requests revalidate the complete result. A larger diagnostic timing alone does not justify weakening
that check or introducing another cache/controller.

Release acceptance requires the exact source's native full and PR-context checks,
all applicable owner criteria above, and separate API/UI deployment identities.
Finite fixture CPU/wall/memory observations describe that runner only. Production
CPU distributions, peak heap and fleet walk-completion rates are not required by
the owner acceptance comment and are not inferred from these fixtures. No
production stress, fleet query, migration or data/access change is part of this fix.
Keep #12094 open until the actual acceptance and deployment evidence is complete.
