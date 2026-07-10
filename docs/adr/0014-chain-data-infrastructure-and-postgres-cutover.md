# ADR 0014 — Chain-data infrastructure: the real self-hosted core, D1's reliability crisis, and the Postgres serving cutover

- **Status:** Accepted — supersedes ADR 0010 (chain-direct block explorer), ADR
  0012 (chain-data ingestion), and ADR 0013 (hybrid deployment topology) in
  full, and supersedes ADR 0006 (provenance-tiered storage)'s D1/dynamic-data
  tier section specifically (0006's git-tier and R2-tier decisions are
  unaffected and remain in force).
- **Date:** 2026-07-10
- **Why superseded, not amended:** 0013 accumulated four inline "Amendment"
  blocks over two weeks (Railway retirement, a Rust rewrite, a node-tier
  reversal, a poller/streamer relocation) and each amendment was itself stale
  or contradicted within days by the next real event. Patching a live
  document faster than reality changes stopped working; this ADR is a single,
  freshly-verified snapshot instead, written the way ADRs are supposed to
  work — a new record replaces an outdated one rather than growing another
  correction on top of it. If reality moves again, write ADR 0015; don't
  reopen this one.
- **Relates to:** #4746 (D1 write-path reliability, the incident that
  triggered this rewrite), #4686 (Postgres-tier subrequest cancellation),
  #4695 (extrinsics parity harness), #4669 (call_args shape reconciliation
  roadmap), #4698 (a D1 coverage gap traced to this same mechanism), the
  private `metagraphed-indexer-rs` repo, and JSO-2054/#2518 (archive-node
  hardware decision).

## Context — verified directly against running infrastructure, not inherited from prior docs

**The indexer box (`meta-indexer-01-us-lax1`) is the real, permanent core —
not a Railway stopgap.** It runs, self-hosted, with no Railway involvement:
`indexer-rs` (Rust, live-follows the finalized chain head), `indexer-rs-backfill`
(sharded historical decode), `metagraphed-indexer-postgres-1` (TimescaleDB,
the durable chain sink both indexers write to), `metagraphed-indexer-redis-1`
(cursor state), `metagraphed-registry-postgres-1` (a _separate_ Postgres
instance for registry data — different scale, different write cadence, kept
independent so one can't take the other down), and `metagraphed-streamer`
(described below). Railway's only remaining role anywhere in this system is
`wss-lb`. ADR 0013's "Railway core, Hetzner escape hatch" framing described a
plan that was overtaken by events — the team went straight to bare metal.

**A separate, full archive node (`meta-archive-01-us-nyc1`) is live but not
yet caught up.** `node-subtensor --sync=full --state-pruning=archive
--blocks-pruning=archive`, syncing from genesis. As of this writing it is
**~51% synced** to chain tip (measured via `system_syncState`), restarting
roughly every 12 hours (a stability wrinkle, not fatal), and is expected to
reach chain tip in **another 1–2 weeks**. Until it does, `indexer-rs-backfill`'s
historical decode runs against a **temporary** public OnFinality WS endpoint —
this is explicitly a stopgap, not a design choice, and nothing should be
built assuming it's permanent. Deep historical re-backfill work (below) is
gated on this node reaching steady state; live-forward ingestion is not.

**D1 is fed by a second, independent live-following pipeline — the realtime
streamer — and that pipeline is now a confirmed reliability problem, not an
assumed-safe one.** `scripts/stream-events.py` (a Python process, container
`metagraphed-streamer` on the same indexer box) subscribes to finalized heads
and pushes decoded rows to the edge Worker's `/api/v1/internal/blocks` and
`/internal/events`, which write to D1's `blocks`/`extrinsics`/`account_events`
tables. This is genuinely a _different_ codebase and a _different_ live
indexer from `indexer-rs` — two independent processes, right now, both
following the chain tip, writing to two different databases. The GitHub
Actions backstop poller that used to catch gaps in this specific pipeline
(`refresh-events.yml`) was deleted 2026-07-04 on the premise that the
self-hosted streamer alone would be reliable enough. **That premise is now
disproven:** #4746 found the streamer sustaining 154 `ingest_write_failed`
errors and 15 WebSocket reconnects in a 3-hour window, continuously, with
zero container restarts — not a crash, a live degradation — traced to a
plausible mechanism where a blocking retry loop on a failed D1 write starves
the same connection servicing the chain-head subscription, and a subscription
reconnect silently, permanently skips whatever finalized during the gap
(finalized-head subscriptions don't backfill missed notifications). This
produced measured recent-block coverage as low as 38–61% missing in several
1000-block windows near the chain tip, against 0% missing in an older window.

**D1 has now hit its ~10GB hard capacity ceiling in production once, and was
independently found teetering on it again today.** `account_events` grew
unbounded (365-day retention that never actually got old enough to prune,
because the table was younger than that) until it triggered `D1_ERROR:
Exceeded maximum DB size` — a full write outage — on 2026-07-04, fixed with
an emergency cut to 3-day retention. `blocks` and `extrinsics` were never
given the same fix and were found today in the _identical_ state: their
oldest row was only ~16 days old (retention had never once engaged for
either), the shared database was at 9.0GB of its 10GB cap, and extrinsics at
~101k rows/day would be ~45GB at a true 365-day steady state — more than 4x
the entire cap on its own. **Fixed 2026-07-10** (`BLOCK_RETENTION_MS` → 30
days, `EXTRINSIC_RETENTION_MS` → 5 days) — this is an emergency-driven number
matching `account_events`' own precedent, not a product decision, and is
explicitly meant to be raised only once Postgres serving is trusted.

**Hyperdrive + a dedicated `data-api` Worker already exist and already CAN
serve blocks/extrinsics/account_events from Postgres — the one live attempt
to rely on this was reverted the same day.** `METAGRAPH_BLOCKS_SOURCE` was
flipped to `"postgres"` on 2026-07-09 on the strength of a spot check that
turned out unfalsifiable (`tryPostgresTier` silently swallows every failure
and falls back to D1, so comparing API output against direct Postgres can't
tell a genuine hit from a masked fallback). Live re-testing found the
`DATA_API` service-binding subrequest reporting `outcome: "canceled"` on a
real, reproducible fraction of requests (#4686), so the flag was reverted
same day. **Root-caused 2026-07-10** against Cloudflare's own Hyperdrive
documentation: neither `data-api.mjs` nor `registry-sync-api.mjs` wrapped
their per-request queries in a transaction, so a standalone `SET
statement_timeout` had no guarantee of landing on the same physical
connection as the query that followed it (Hyperdrive resets session state
between pooled connections); both also called `sql.end()` on every request,
which Cloudflare's docs explicitly say is unsupported, unnecessary extra
work. Both are fixed (each request's queries now run inside `sql.begin()`;
the manual teardown is removed) but **not yet re-verified live** — the next
concrete step, not an assumption to build further work on top of.

**Extrinsics carries an additional, separate blocker beyond the connection
bugs above.** `indexer-rs`'s decoded `call_args` diverged from D1's decode
shape across roughly 45 of 105 sampled call types (SS58/hex encoding,
`Option<T>` unwrapping, nested `RuntimeCall` reconstruction, Ethereum
U256/H160 shapes, and more). The root bug in `indexer-rs` was fixed
2026-07-10, but only for blocks decoded from ~8589233 onward — every row
written before that fix still has the old, wrong shape, and needs a full
re-decode once the archive node is available for it. This is independent of,
and does not block, the connection-affinity fix above.

**All three cutover flags currently read `"d1"`** (`wrangler.jsonc`:
`METAGRAPH_BLOCKS_SOURCE`, `METAGRAPH_EXTRINSICS_SOURCE`,
`METAGRAPH_ACCOUNT_EVENTS_SOURCE`). D1 is today's sole production default not
because it's the durable, correct end state, but because the Postgres
alternative hasn't yet been proven reliable in production — the opposite of
what "hot cache, Postgres is truth" was supposed to mean by now.

## Decision

1. **The self-hosted indexer box is the permanent core.** Not a Railway
   interim step — treat Postgres/Timescale + `indexer-rs` + Redis on
   dedicated hardware as the durable, long-term chain-data sink. Railway's
   only remaining role in this system is `wss-lb`; don't plan around
   reintroducing it.
2. **D1 is a temporary, deliberately reliability-constrained hot cache for
   live (last few days) data only** — fed by the realtime streamer — kept
   alive _only_ until each tier's Postgres serving is proven reliable, not an
   architectural end state. Its per-tier retention (30d blocks / 5d
   extrinsics / 3d account_events as of this ADR) is an emergency-calibrated
   number tied to measured ingestion volume and the shared 10GB cap, not a
   product decision — don't raise any of them without re-measuring current
   volume against remaining headroom first.
3. **A tier's cutover flag flips to `"postgres"` only when all of the
   following hold**, learning directly from the first attempt's failure:
   - The specific bugs already found for that serving path are fixed and
     merged (for blocks/extrinsics/account_events: the Hyperdrive
     connection-affinity fix, #4686).
   - Live re-verification uses a block/extrinsic/event confirmed to exist
     **only** in Postgres, not one present in both stores — a both-stores
     row cannot distinguish genuine Postgres serving from a silently masked
     D1 fallback, which is exactly how the first "verified" flip turned out
     to be unfalsifiable.
   - `tryPostgresTier`'s per-branch failure logging (already shipped) shows
     zero unexplained fallbacks over a sustained live window — not a single
     spot check.
   - For extrinsics specifically: the call-args parity harness (#4695)
     confirms shape-identical output across a representative sample of call
     types, not just the ones already spot-checked.
4. **Deep historical correctness is a separate, slower effort — do not
   conflate it with live-serving readiness.** Re-decoding pre-fix
   blocks/extrinsics and backfilling gaps from before `indexer-rs` went live
   both require the self-hosted archive node at or near chain tip (operator
   estimate: 1–2 weeks from this ADR's date). Cutting a tier's _live_ serving
   over to Postgres does not require this — "recent data is trustworthy" and
   "all of history is" are different claims with different gates.
5. **The realtime streamer's reliability is now a first-class, tracked
   concern, not an assumed property.** Its push-retry loop currently blocks
   the same execution path that services its chain-head subscription — fix
   this (tracked in #4746) independent of the Postgres cutover, since D1
   remains load-bearing for however long the cutover takes.
6. **Once a tier's Postgres serving is proven and its D1 role is fully
   retired, delete that tier's D1 table and prune logic** rather than
   leaving it running as inert legacy weight.

## Consequences

**Gains (once the sequencing below completes):** real, uncapped deep
history; D1's capacity ceiling stops being an operational hazard because
nothing durable depends on it; one first-party, self-hosted source of truth
per data class instead of two independent live-following pipelines that can
silently drift from each other.

**Costs / risks — tracked, not hand-waved:**

- **Two live pipelines exist simultaneously during the transition** (the
  streamer → D1, `indexer-rs` → Postgres) and can disagree; this is exactly
  what surfaced the extrinsics shape divergence and the account*events D1
  gap (#4698) as \_findings*, not silent corruption — a property worth
  keeping until the cutover is trusted, not a bug to rush away.
- **D1 remains a genuine, load-bearing production dependency** — not
  actually a "hot cache" in truth — until every tier's cutover completes.
  Treat its reliability (retention, the streamer's write path) as an active
  concern, not a deprecated corner.
- **The archive-node timeline is a real, external constraint** (1–2 weeks as
  of this ADR). Deep-history work should wait for it rather than substitute
  a lower-quality source under time pressure — the temporary OnFinality
  backfill source exists precisely to avoid that trade.
- **A cutover verified against Postgres-only data can still regress** if the
  underlying bug class (silent-fallback masking a failure) isn't watched for
  in future changes to `tryPostgresTier` or the `data-api`/`registry-sync-api`
  Workers — the logging added in #4686's follow-up is the guardrail; don't
  remove it as "noise."

## Sequencing

1. ✅ **Foundation.** Self-hosted Postgres/Timescale + `indexer-rs` + Redis on
   the indexer box, replacing the original Railway plan. Done.
2. ✅ **D1 capacity emergency fixed.** `blocks`/`extrinsics` retention
   corrected to match `account_events`' precedent (merged 2026-07-10).
3. ✅ **Hyperdrive connection-affinity fixed.** `data-api.mjs` and
   `registry-sync-api.mjs` now run each request's queries inside a
   transaction and no longer call `sql.end()` (merged 2026-07-10),
   addressing #4686's two documented root-cause candidates.
4. 🔲 **Re-verify blocks Postgres serving live** against a Postgres-only
   block per Decision point 3's criteria; re-flip `METAGRAPH_BLOCKS_SOURCE`
   only on a clean, sustained result — not a repeat of the first spot check.
5. 🔲 **Fix the streamer's push-retry/subscription coupling** (#4746's
   remaining half) so D1 stays reliable for however long it remains
   load-bearing during the transition.
6. 🔲 **Reconsider automatic gap-detection for the streamer**, now that "the
   self-hosted streamer alone is reliable enough" has been disproven once —
   don't leave gap recovery manual-only without re-justifying that decision
   against current evidence.
7. 🔲 **Complete the extrinsics parity harness** (#4695) and flip
   `METAGRAPH_EXTRINSICS_SOURCE` once shape-verified, independent of the
   connection-affinity fix which only addresses transport reliability, not
   decode-shape correctness.
8. 🔲 **account_events:** the Postgres serving route already exists (#4696);
   verify per Decision point 3's criteria and flip
   `METAGRAPH_ACCOUNT_EVENTS_SOURCE`.
9. 🔲 **Full historical re-backfill (archive-gated, ~1–2 week external
   timeline).** Re-decode pre-fix blocks/extrinsics in Postgres once the
   archive node reaches chain tip; do not attempt this against the temporary
   OnFinality source — that source exists for exactly this reason.
10. 🔲 **Retire D1.** Once every tier is proven reliable on Postgres: delete
    the prune-and-discard logic, the D1 tables, and the realtime streamer
    (superseded by `indexer-rs`, which already covers live-follow) — don't
    leave a redundant second live pipeline running once it's no longer
    load-bearing.

## Links/resources

- `workers/data-api.mjs`, `workers/registry-sync-api.mjs` — the Hyperdrive-backed
  Postgres serving/write Workers (connection-affinity fix, 2026-07-10)
- `workers/postgres-tier.mjs` (`tryPostgresTier`) — the per-tier fallback
  contract shared by REST and MCP callers
- `src/blocks.mjs`, `src/extrinsics.mjs`, `src/account-events.mjs` —
  `BLOCK_RETENTION_MS` / `EXTRINSIC_RETENTION_MS` / `EVENT_RETENTION_MS` and
  their prune functions
- `scripts/stream-events.py`, `docs/realtime-streamer.md` — the realtime
  streamer and its "no automatic backstop" reasoning, now under review (#4746)
- `.github/workflows/backfill-events.yml` — the manual-only D1 gap-recovery path
- `wrangler.jsonc` — `METAGRAPH_BLOCKS_SOURCE` / `METAGRAPH_EXTRINSICS_SOURCE`
  / `METAGRAPH_ACCOUNT_EVENTS_SOURCE`
- #4746, #4686, #4695, #4669, #4698, #4684, #4654 — the issues this ADR
  consolidates evidence from
- Private `JSONbored/metagraphed-indexer-rs` repo — the Rust continuous
  indexer + backfill implementation
- JSO-2054/#2518 — the archive-node hardware decision
