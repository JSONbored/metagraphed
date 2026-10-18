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
No old rows are stored; any matching-row mutation can require a restart. The
digest is computed only for opted-in requests, with work proportional to the
filtered row payload. CPU/memory and cache/freshness behavior need native
measurement before rollout. A cached guarded page still belongs to its stated
content generation; a cache miss after a mutation can require a restart.

The additive REST parameter and optional metadata field preserve existing
numeric cursor types and unguarded responses. MCP tools and GraphQL do not
advertise this mode until forwarding, output and restart contracts are
implemented there. Their existing offset behavior is preserved.

The endpoint, API catalog and provider views opt in through their shared
infinite-query helper. A mismatch stops continuation without automatic retries.
Refresh cancels pending pages, clears accumulated rows and starts at cursor zero
with the same filters. Late responses cannot append to the new query generation.
Each continuation must preserve both the first snapshot and total.

Those tables' CSV action starts a fresh checked walk and downloads only after
it completes. It preserves filters, shown columns and client sorting. Changed
results, network switches, navigation or view changes cancel the attempt rather
than emit a partial file. Exports are bounded to 50 pages, 50,000 rows and 16 MiB
of row JSON; users can narrow filters after a limit error. Provider probe columns
still merge separately cached endpoint evidence: the guard certifies the catalog
row walk, not one atomic capture spanning both sources.

The digest streams canonical rows already loaded by the collection handler. It
adds no storage queries, but costs linear CPU and per-row serialization on every
guarded cache miss. Existing artifact hashes do not cover all live overlays and
cannot safely replace that identity. Native cost and churn measurements remain
required; this source patch alone does not certify rollout acceptance for #12094.

Regenerate OpenAPI/types/client and relevant docs in the authorized native
environment, then run required schema, parity, route, coverage and UI/browser
checks. No generated output is hand-edited. Source regressions are prepared;
they were not executed on Mac.

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
the token remains valid. There is no time-based token lease: old cached content
may remain coherent while stale, and a miss may reject an older token. Changing
or reverting source content can reproduce an earlier digest.

MCP has 33 shared-pager calls across 31 modules, including the generic inline
pagers in `mcp-server.ts`. Manual `list_subnets`, `search_subnets` and
`find_subnets_by_capability` retain their offsets; `applySubnetListQuery` also
pages snapshot, health, trajectory, endpoint/candidate/evidence/surface,
fixture, freshness, agent-catalog and coverage-depth views. These transports
preserve legacy behavior and make no checked-walk guarantee. The capped
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
population; a warmed walk must avoid artifact reads. Source bytes, response
bytes, page counts, cache entries, wall time, process CPU, sampled heap/RSS
high-water values and heap deltas are recorded. Timing and memory never decide
pass/fail.

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
pages still verify the complete matching content; warm URL hits use the
existing cache. A larger diagnostic timing alone does not justify weakening
that check or introducing another cache/controller.

Production acceptance requires passive evidence from existing invocations at
a known deployed revision: bounded sampled CPU/wall/error observations for
these paths, distinguishing guarded/legacy and cache/source/freshness states
where already recorded. Existing client export completion/restart/failure
receipts would be needed to estimate walk success across health transitions;
request totals cannot substitute for walk correlation. If those fields or
client receipts are absent, that evidence is unavailable without separately
reviewed instrumentation. No production load test, new traffic, fleet query or
memory-peak claim follows from these fixtures. Keep #12094 open until that
remaining acceptance is explicitly resolved.
