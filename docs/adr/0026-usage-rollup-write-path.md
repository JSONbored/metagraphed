# ADR 0026 — Usage-rollup write path: isolate-scoped buffering, not sampling or a log-derived rollup

- **Status:** Accepted · implemented (#8823)
- **Date:** 2026-07-31
- **Relates to:** #8823 (this ADR), #8597 (`api_usage_rollup`, the table this
  writes and the pricing question it exists to answer), ADR 0022 (the deferred
  paid-tier decision the rollup feeds), ADR 0014 (the self-hosted Postgres whose
  capacity is the constraint here)

## Context

Every request to any `/api/v1/*` path drove **one Postgres write** on the
self-hosted indexer box, with no authentication and no rate limit in front of
it.

`workers/api.ts` calls `recordUsageRollup` for any path shaped like `/api/v1/…`,
after the OPTIONS early-return and **before** dispatch — so it fires for 404s
and for paths no route serves. That function called
`foldObservations([observation])` on a **single-element array** and POSTed
immediately to `/api/v1/internal/usage-rollup`, which runs an
`INSERT … ON CONFLICT (day, route_family, cost_shape) DO UPDATE` inside
`withAccountsSql` — and `withAccountsSql` constructs a **new `postgres()` client
per invocation**.

`handleUsageRollupIncrement`'s own header comment claimed the caller coalesced
observations before sending. It did not. `foldObservations` is real and correct;
it simply never saw more than one observation on the write path. There was no
cross-request buffer anywhere in the Worker, so an isolate serving 500 requests
issued 500 subrequests and 500 upserts.

**Unmatched traffic is the worst case.** `routeFamily` collapses every
non-matching path to a single `UNMATCHED_FAMILY = "unmatched"` bucket —
deliberately, to avoid a cardinality bomb — and degenerate input gets the `edge`
cost shape. So a flood of `GET /api/v1/<random>` 404s all target **one row**:
`(day, "unmatched", "edge")`. Every request contended for that row's lock,
serialised, each with a fresh connection. Nothing throttles it: `/api/*` is
`run_worker_first`, the tiered and per-surface limiters live inside individual
route branches, and the generic 404 is reached without passing any of them.

The failure mode is bounded but real. The write is fire-and-forget and swallows
its own errors, so API responses stay correct; what degrades is the Postgres
instance the indexer depends on. It is also a standing scaling hazard for
legitimate traffic, not only for a deliberate flood.

## Decision

**Option A — isolate-scoped buffering with a count-or-age flush.**

`recordUsageRollup` appends its `UsageObservation` to a module-scope buffer in
the Worker isolate. When the buffer reaches **64 observations**, or when **10
seconds** have elapsed since the first observation in the current buffer, the
whole buffer is folded with `foldObservations` and sent as **one** subrequest
carrying one bucket per `(day, route_family, cost_shape)`. The flush rides the
triggering request's `ctx.waitUntil`, so it adds no latency, exactly as the
single-observation write did.

The buffer is drained **before** the fetch is issued, so a concurrent request in
the same isolate cannot re-send the same observations.

### Why not B (sampling)

Sampling turns `api_usage_rollup.request_count` into an estimate. The table
exists to answer ADR 0022's deferred pricing question — "does the free tier cost
too much" — and the answer is a cost figure someone will multiply by a rate. An
estimate with an unstated confidence interval is worse than a smaller exact
number, and the scale factor would have to be versioned into the rows to stay
interpretable across a threshold change. Buffering gets the same write reduction
without giving up exactness for observed requests.

### Why not C (derive the rollup off the request path)

Cloudflare Logpush / Workers Analytics Engine / PostHog can all carry request
volume, but none of them carries `route_family` — that label is produced by
`routeFamily()` matching the Worker's own dispatch order, which is the property
that makes the rollup attribute a request to the route that actually served it.
Reconstructing it from a log stream means reimplementing that matcher against
raw paths in a second place and keeping the two in step forever. C also trades
freshness for a scheduled job and adds a dependency for a table that currently
has none. It stays a reasonable future option if per-isolate write volume ever
becomes the constraint again; it is not worth its cost today.

## Consequences

### Write volume

An isolate serving N requests now issues `ceil(N / 64)` subrequests, upserts,
and `postgres()` clients instead of N — a **64x** reduction per isolate at
steady load, and more than that for a burst to one family, since the batch also
collapses N observations into a single bucket per `(day, family, shape)` rather
than N separate upserts against the same row. The `(day, "unmatched", "edge")`
row lock, the specific contention point an unauthenticated flood targets, is
taken once per flush instead of once per request.

Per-isolate is the honest bound: many isolates still means many writers. This
does not make the write path free, it makes each writer 64x quieter. That is
sufficient for the hazard as it exists; it is not a claim that the write path is
now unconditionally safe at any scale.

### Accuracy — the one thing that changes

`request_count` and `keyed_count` keep their meaning exactly: **exact counts of
observed requests**, not sampled and not estimated. Nothing is scaled.

The new loss mode is **isolate eviction with a partially-filled buffer**. An
isolate that is evicted mid-buffer loses at most **63 observations**, and — since
the age trigger can only fire when a later request arrives — an isolate whose
traffic stops entirely holds its last partial buffer until eviction. Both bounds
are why the thresholds are small rather than tuned for maximum batching. This
under-counts; it never over-counts, so the rollup remains a floor on real
traffic, which is the safe direction for a cost estimate.

### Unmatched paths are still counted

Deliberately. They are the entire abuse surface, and "how much 404/scanner
volume is this API absorbing" is a real input to the same capacity question the
table serves. What made them expensive was not that they were counted but that
each one was a write; folding makes a flood of them cost one bucket per flush.
The single-bucket collapse that made them the worst case is now the thing that
makes them the cheapest.

### Connection reuse is NOT addressed here

`withAccountsSql` constructing a new `postgres()` client per invocation is a
per-write cost independent of this decision, and it affects **every**
accounts-tier route, not just this one. Fixing it inside a usage-rollup change
would be both out of scope and under-tested for the other routes it would
silently alter. Split into its own issue; buffering already removes 63 of every
64 client constructions on this path.
