# ADR 0013 — Hybrid deployment topology: Cloudflare edge · Railway core · Postgres migration

- **Status:** Accepted — ratified 2026-06-27. Implements the deployment + storage
  topology for the continuous indexer that ADR 0012 left as "the end state."
  Foundation (this ADR + the portable schema + runbook) shipped; provisioning and
  the serving cutover are gated, phased steps (see _Sequencing_).
- **Date:** 2026-06-27
- **Relates to:** ADR 0010 (chain-direct block explorer), ADR 0012 (chain-data
  ingestion — the continuous indexer this deploys), ADR 0001/0006 (storage tiers),
  and the own-the-core infrastructure program (#1345, #1349, #1519, #1749).

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
event_index)`) so the serving code (`src/blocks.mjs`, `extrinsics.mjs`,
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
