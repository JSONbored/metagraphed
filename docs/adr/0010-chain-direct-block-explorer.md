# ADR 0010 — Chain-direct block explorer + first-party event indexer

- **Status:** Accepted (partial) — first-party ingestion + serving shipped
  (#1345 vertical slices: blocks, extrinsics, account events; Aura block-author
  decode). Deep history (#1519 R2 SQL, #1349 archive RPC) is pending the
  self-hosted infrastructure.
- **Date:** 2026-06-23
- **Relates to:** ADR 0006 (provenance-tiered storage — D1 for dynamic data) and
  ADR 0002 (the existing probe / RPC-pool plane this reuses).

## Context

Developers and agents want chain-level context — recent blocks, extrinsics, an
account's activity, per-UID metagraph history — alongside the registry's
operational data. metagraphed had none of it first-party, and leaning on a
third-party indexer (Taostats) makes the explorer a dependency with its own
freshness, rate limits, and cost.

## Decision

Build a **first-party, chain-direct indexer** as the spine, with Taostats demoted
to **backfill / fallback only**:

- A poller (`scripts/fetch-events.py`, substrate-interface against public finney
  RPC) decodes a recent window of finalized blocks into the `blocks`,
  `extrinsics`, and `account_events` D1 tiers (migrations 0013 / 0014 / 0009),
  bulk-loaded idempotently. Block author is decoded from the **Aura PreRuntime
  digest** (slot → `Aura.Authorities[slot % n]`, ss58).
- **D1 holds the hot window** — recent blocks/events the public node still retains
  state for. It is bounded and self-pruning.
- **Deep history is a separate, infra-gated phase** — R2 Iceberg + R2 SQL (#1519)
  and an archive RPC (#1349) for full-history queries, landing with the
  self-hosted infrastructure (own-the-core / rent-the-edge).

## Consequences

- **No third-party dependency for the live explorer.** `/api/v1/blocks`,
  `/extrinsics`, and `/accounts/{ss58}` are first-party and fresh; Taostats is a
  fallback, not the source of truth.
- **Bounded by public-RPC state pruning.** The hot window is small — the public
  node discards old state (~hundreds of blocks), so a full historical backfill
  needs the archive (Phase 2). This is _why_ entity-history depth is staged and
  why the live backfill of older block authors is limited.
- **Reuses the data plane** — D1 + the publish/serve path (ADR 0006), not a new
  store.
- **The frontend is staged too** — universal search is live; account/extrinsic
  entity pages pair with the deep backend (#1350).
