# ADR 0012 — Chain-data ingestion: bootstrap poller → self-hosted archive indexer

- **Status:** Proposed (recommended) — pending ratification + infrastructure
  provisioning. The measured problem and the bootstrap's limits are facts; the
  target architecture is the recommended decision.
- **Date:** 2026-06-24
- **Relates to:** ADR 0010 (chain-direct block explorer — this is the Phase-2
  ingestion it deferred), ADR 0006 (provenance-tiered storage), and the
  own-the-core infrastructure program (#1345, #1349, #1519).

## Context

The block explorer's first-party ingestion (ADR 0010) ships today as a **$0
bootstrap**: a Python poller (`scripts/fetch-events.py`) on a GitHub Actions cron
(`refresh-events.yml`, `*/5`) decodes a recent window of finalized finney blocks
over **public** RPC, stages JSON to R2, and the Worker bulk-loads it into D1
(`blocks` / `extrinsics` / `account_events`). It powers `/api/v1/blocks`,
`/extrinsics`, and `/accounts/{ss58}` history.

Two **structural** limits have now been measured in production — both
infrastructural, neither a logic bug:

1. **Trigger coalescing.** GitHub does not honor a `*/5` schedule; it collapses it
   to roughly **once every 1.5–4.5 hours** (20 consecutive runs observed at 76–265
   min intervals). So **380–1,325 blocks** are produced between runs.
2. **Prune wall.** Public finney nodes discard historical state at **~300 blocks**
   (the #1718 author backfill hit the wall at ~87). The poller re-scans only the
   last `EVENTS_WINDOW` (250) blocks, and `compute_from_block` deliberately caps at
   that window floor (it is tested to _not_ chase the cursor). Blocks produced
   between runs but older than the window are never scanned — and are pruned before
   any later run could reach them.

**Measured impact:** the `blocks` D1 tier holds 2,500 rows over a 5,953-block span
— **3,453 blocks (58%) missing**, in regular gaps of 131–769 that track
(inter-run interval − window). `account_events` and `extrinsics` come from the
same loop, so they have the **same holes** — `/accounts/{ss58}` history is roughly
half-complete.

**No poller-code change fixes this.** With window 250 and prune ~300, the most
extra coverage any window/cursor tweak can buy is ~50 blocks per run, against
130–1,025-block gaps. The disease is a scheduler we don't control plus a node that
prunes — not the scan logic.

## Decision (proposed)

Treat the public-RPC + GitHub-cron poller as the **bootstrap tier only**, and make
the durable ingestion a **continuously-running, first-party indexer against an
archive node** — the own-the-core direction already chosen for the infrastructure
program:

- **Continuous indexer** — a long-running service (not a cron job) that follows the
  finalized head block-by-block from a durable cursor. No scheduler to coalesce ⇒
  **zero trigger gaps**.
- **Archive node** — retains full historical state ⇒ **no prune wall** ⇒ complete
  history and arbitrary backfill. Self-hosted (own-the-core) is the recommended
  end state; a **managed archive RPC** (≈$50–200/mo) is the lower-ops alternative
  and an acceptable first step.
- **Provenance-tiered sink** (ADR 0006) — Postgres in the own-the-core plan, D1
  today — written with the same idempotent keys, so the serving layer is unchanged.

**Migration.** The indexer supersedes `fetch-events.py` + `refresh-events.yml`; the
bootstrap is retired once the indexer is live and has backfilled the recent window.
Until then the bootstrap stays (best-effort, gappy) and its docs must state the
limitation honestly — no cursor-recovery claim it does not implement.

**Open sub-decisions (why this is Proposed, not Accepted):** self-hosted archive
node vs managed archive RPC (control vs cost/ops); and build now vs fold into the
broader own-the-core migration.

## Consequences

- **Complete, gap-free chain data** — both the live-forward series and deep history
  — independent of GitHub's scheduler and public-RPC pruning.
- **Infra cost/ops** — an archive node (or managed archive RPC) plus a hosted
  indexer process. This is the own-the-core tradeoff already on the roadmap.
- **Interim** — the bootstrap keeps serving a best-effort recent window with known
  gaps. An optional reliable-trigger bridge (a Cloudflare-cron `workflow_dispatch`)
  could cut the live-forward loss in the meantime, but it is throwaway once the
  indexer lands.
- **Existing gaps are not backfillable now** — the missing blocks are long past the
  public prune horizon; they return only once an archive source exists.
