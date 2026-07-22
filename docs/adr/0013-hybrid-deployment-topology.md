# ADR 0013 — Hybrid deployment topology: Cloudflare edge · Railway core · Postgres migration

- **Status:** Superseded by [ADR 0014](0014-chain-data-infrastructure-and-postgres-cutover.md).
  This ADR's own inline amendments (below) already tracked three real pivots
  since ratification (Railway retirement, the Rust rewrite, the node-tier
  reversal), and each amendment was itself stale or contradicted within days —
  most notably, Decision 1's "Railway core" is factually wrong today (the
  indexer box is bare metal, not Railway), and the serving cutover this ADR
  targets was attempted once and reverted the same day (#4686). ADR 0014 is a
  fresh, single, directly-verified snapshot rather than another amendment.
- **Date:** 2026-06-27 (ratified)
- **Relates to:** ADR 0010 (chain-direct block explorer), ADR 0012 (chain-data
  ingestion — the continuous indexer this deploys), ADR 0001/0006 (storage tiers),
  and the own-the-core infrastructure program (#1345, #1349, #1519, #1749).

> **Amendment (2026-06-27): node tier is a FULL ARCHIVE, superseding the
> pruned-node default below.** We are running a real archive node
> (`--pruning=archive --sync=full`, complete state from genesis, ~3.5 TB+ on
> ~8 TB+ NVMe) on the dedicated box, not a 128 GB pruned node. Rationale: a pruned
> node is not a true archive — it can't serve historical state queries or be a
> self-sufficient backfill source, and we want a **first-party archive RPC origin**
> (addable to the RPC/WSS pools) independent of public archives' rate limits. The
> cost the original decision avoided (the ~3.5 TB archive) is consciously accepted
> for that capability. The pruned-node + transient-public-backfill path below
> remains the cheaper dev/interim fallback (`SUBTENSOR_PRUNING=2000`). Everything
> else in this ADR (CF edge · Postgres · Hyperdrive cutover · sequencing) stands.

> **Amendment (2026-07-03): the continuous indexer is Rust, not Python, and the
> schema's TimescaleDB section had a real bug (now fixed).** `scripts/index-chain.py`
> and `scripts/backfill-chain.py` (referenced below and in `deploy/README.md`)
> are retired — a Rust implementation (live-follow + sharded historical backfill
> in one binary) replaces both, verified faster and handling more event
> coverage. Its source lives in the private `JSONbored/metagraphed-indexer-rs`
> repo (a remote was added 2026-07-03, closing the "exactly one place with no
> backup" risk this amendment originally flagged) — confirmed 2026-07-09 that
> the repo's last commit timestamp matches the deployed image's build time to
> within 3 minutes. Separately: `deploy/postgres/schema.sql`'s TimescaleDB hypertable
> section, as originally committed, could never actually apply —
> `create_hypertable()` requires the partition column (`observed_at`) in every
> unique constraint, and none of the original primary keys included it. Fixed
> by making `observed_at` part of each composite PK (functionally a no-op for
> real-world uniqueness, since `observed_at` is already determined by
> `block_number`) and moving the TimescaleDB section into its own optional
> `deploy/postgres/schema-timescaledb.sql`, now that it's verified working —
> unconditionally running `CREATE EXTENSION timescaledb` from inside
> `schema.sql` itself would break the plain-Postgres/Railway path the base
> schema is supposed to support. JSO-2054/#2518's option (a) decision
> (Postgres/TimescaleDB, no columnar sibling) stands unchanged.

> **Amendment (2026-07-04): the poller and the streamer's Railway hosting were
> retired early, independent of the Sequencing plan below.** The GitHub `*/5`
> poller (`refresh-events.yml`) is deleted, and the realtime streamer
> (`scripts/stream-events.py`) has moved off Railway onto the self-hosted
> indexer box (Ansible `streamer` role), with the Railway `metagraphed-streamer`
> project deleted. Both happened ahead of, and decoupled from, the gated
> Sequencing steps below — the trigger was the streamer having a verified-working
> redundant copy (self-hosted) rather than the full Postgres/Hyperdrive cutover
> completing. The `*/3` R2-staging drain and D1's demotion to a hot cache remain
> gated on that real cutover and are unaffected — the drain is still fed by the
> manual `backfill-events.yml` workflow and must not be removed early.

## Context

The explorer's chain data is structurally a **rolling cache, not an archive**, and
the system is engineered around Cloudflare's ceilings rather than the data:

- **Storage ceiling.** The chain sink is **D1 (~10 GB cap)**, so `blocks` /
  `extrinsics` / `account_events` are **pruned and discarded** past ~90 days
  (`migrations/0013_blocks.sql`). Every history feature (weights/stake/pool/
  economics/balance over time) is blocked by this.
- **Ingestion gaps.** Two public-RPC tiers feed it: a GitHub `*/5` poller (GitHub
  **coalesces it to ~1.5–4.5 h → ~58 % of blocks missed**, ADR 0012) and the
  Railway streamer. Neither is gap-free.
- **Compute ceiling.** Daily rollups (the ~33k-row neuron rollup), uptime/event
  aggregates, and on-request `GROUP BY`s run **in the Worker isolate** with
  row-cap gymnastics and subrequest limits.
- **Third-party dependency.** The per-UID metagraph tier is **Taostats-sourced**
  (the only non-first-party tier) and **daily** granularity.

ADR 0012 ratified the _continuous indexer_ as the ingestion end-state but did not
decide **where each piece runs** or **what replaces D1**. The owner's stated
direction is **"own the core, rent the edge."**

A cost note that shaped this decision: a permanent **archive node is ~3.5 TB and
growing ~1.4 TB/yr** (subtensor docs, Mar 2026), which is prohibitive on metered
volume storage. A **lite/pruned node is only 128 GB.**

## Decision

Adopt a three-tier hybrid. **Cloudflare = rented edge, Railway = owned compute
core, Postgres = the durable chain sink** (Railway now, Hetzner escape hatch),
with one Railway project for everything off the edge.

1. **One Railway project `metagraphed-core`** (environments `production` +
   `staging`) holds every off-edge service, on one private WireGuard network
   (`<service>.railway.internal`, zero egress) with cross-service variable
   references and monorepo deploys. Easiest to operate: one dashboard, one
   network, one bill. Services: `postgres`, `redis`, `subtensor-node` (pruned),
   `indexer`, `health-prober`, `rollups`, `alerter`, `exporter`, `reconciler`.
2. **D1 chain sink → Postgres (TimescaleDB).** The portable schema lives at
   `deploy/postgres/schema.sql` and keeps the existing idempotent keys
   (`block_number` / `(block_number, extrinsic_index)` / `(block_number,
event_index)`) so the serving code (`src/blocks.mjs`, `extrinsics.ts`,
   `account-events.mjs`) changes only its binding. **D1 demotes to the hot/recent
   cache**; the prune-and-discard logic is deleted on cutover.
3. **Cloudflare adds two edge primitives and keeps the rest.** A **Hyperdrive**
   binding is the _only_ way the Worker reaches Postgres (pooled + edge query
   cache); one **Durable Object** is the realtime firehose hub (SSE/WS +
   GraphQL subscriptions + MCP). R2 (artifacts + cold Parquet + PG backups, all
   zero-egress), KV, Vectorize, Workers AI, the rate-limiters, the RPC proxy, and
   all REST/GraphQL/MCP serving **stay on Cloudflare**. The embedding-sync cron
   stays on CF (binding-bound).
4. **Continuous indexer replaces poller + streamer + `*/3` drain.** One
   long-running Railway service follows the finalized head from a durable cursor
   (Redis), reusing the verified decode in `scripts/fetch-events.py`, writing
   straight to Postgres over private net. Continuity — not self-hosting — is what
   fixes the 58 % loss.
5. **Pruned node, not a permanent archive.** Run a **128 GB pruned**
   `subtensor-node` for ongoing head-following + a first-party RPC origin (first
   entry in `TRUSTED_RPC_UPSTREAM_ORIGINS`, public nodes demoted to failover).
   The one-time historical backfill uses a **transient** archive source, then is
   torn down — the explorer serves history from Postgres, not node state.
6. **Light services move off CF isolates** to Railway cron/workers against
   Postgres: `health-prober` (stable IP, real retry/backoff, higher concurrency),
   `rollups` (Timescale continuous aggregates), plus net-new `alerter`,
   `exporter` (DuckDB → Parquet/CSV → R2), and `reconciler` (folded-state vs
   runtime drift).

### Why Postgres on Railway _first_ (not Hetzner immediately)

The prohibitive cost was the **permanent 3.5 TB archive node**, which this design
avoids (pruned node + transient backfill). The remaining big store is the
**compressed Timescale history**, which compresses ~10–20× and tiers cold
partitions to R2 — plausibly **low-hundreds of GB for years**, comfortably under
Railway's **1 TB volume cap** at **$0.15/GB-mo**. So:

- **Start with `postgres` on Railway** — in-project, all private-net, simplest.
- **Escape hatch to a Hetzner box** when compressed history crosses ~300–500 GB
  (where a ~€60/mo box beats metered storage) or the 1 TB cap looms. This is
  **low-friction by construction**: the only coupling is `DATABASE_URL` + the
  Hyperdrive config, and the schema is portable vanilla Postgres. Designed for
  portability from day one — no Railway-specific SQL.

## Consequences

**Gains:** deep history retained (prune-and-discard deleted); ingestion ~58 % →
~100 % (no trigger coalescing); heavy aggregations leave the isolate; the
metagraph tier becomes first-party (no Taostats); the explorer becomes
real-time-pushable; one operable core project.

**Costs / risks (tracked, not hand-waved):**

- **New ops surface** — a Railway project to run; mitigated by the single-project
  shape + staging environment.
- **Reconciliation** — folded balances/stake/yield must be diffed against runtime
  truth before users trust portfolio/APY numbers (`reconciler` service).
- **Auth / monetization is a prerequisite** for the write-side services
  (alerts, agent actions) — out of scope here, gating those phases.
- **Backups** — Postgres holds irreplaceable derived state (the node is restorable
  from chain); WAL/dumps → R2 (zero-egress) are mandatory.
- **Test/CI** — reader tests serve R2-only artifacts; a Hyperdrive/Postgres path
  needs integration coverage before cutover.

**This is NOT a blind cutover.** Each phase is independently shippable and gated.

## Sequencing

1. **Foundation** — this ADR + `deploy/postgres/schema.sql` + `deploy/README.md`
   runbook. _(shipped)_
2. **Provision** `metagraphed-core` (postgres + redis), apply the schema, add the
   Hyperdrive binding. Dual-write the chain tiers to Postgres alongside D1 — **no
   serving change.** _(run when the indexer is ready — avoids paying for idle DBs)_
3. **Continuous indexer** replaces poller/streamer/drain; backfill once; **verify
   ~100 % capture vs D1** (gate).
4. **Cut serving over** to Hyperdrive→Postgres tier-by-tier (blocks → extrinsics →
   accounts → metagraph), D1 as fallback; delete prune-and-discard.
5. **Move scheduled jobs** to Railway; add `exporter` + `reconciler`; add the
   Durable Object firehose + `alerter`.
6. **Decommission** the GitHub poller + streamer + `*/3` drain; D1 → hot cache.
