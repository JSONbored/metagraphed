# ADR 0017 — u128 precision Phase 3: no-go on a blanket historical backfill

- **Status:** Accepted — Phase 3 of #2588 is closed as no-go for now. Not a
  permanent decision: revisit if a concrete, specific need for corrected
  historical values arises (see Consequences).
- **Date:** 2026-07-14
- **Relates to:** #2588 (roadmap), #2921 (Phase 1, closed), #2922 (Phase 2,
  closed), #2923 (this decision), #4772/#4908 (D1 chain-data retirement).

## Context — verified directly against running infrastructure, not assumed

#2923 required two things before any implementation: (1) confirm archive-node
reachability at the historical block heights needing backfill, (2) an
explicit go/no-go decision weighing engineering cost against practical
impact. Both are answered here from live queries against the real archive
node and Postgres, not from the original issue's assumptions — which turned
out to be materially wrong about how much lossy data still exists to fix.

**Mechanism A tables (`neurons.stake_tao/emission_tao`, `neuron_daily`,
`subnet_snapshots.total_stake_tao`) — checked each individually:**

- `neurons`: latest-only, upsert-on-conflict table. `MIN(block_number)` in
  production is 8,616,949 — i.e. "now." There is no old lossy data sitting in
  this table to backfill; every row already reflects the current (Phase-1-
  correct) writer.
- `neuron_daily`: `MIN(block_number)` in production is 8,593,440 — only
  ~23,500 blocks (~3.3 days) of history. This table was D1-native until
  #4772/#4908 fully dropped D1's neuron_daily table on 2026-07-11 with no
  precision-preserving migration into Postgres. The old, lossy D1 rows this
  issue was written to recover are gone — not in D1 (dropped), not in
  Postgres (never copied). There is nothing left to backfill; the
  "mechanism A" concern for this table is moot, not solved.
- `subnet_snapshots`: Postgres-native since early in the project (migration
  0002, not part of the D1 retirement). Real history: 2025-06-23 through
  today, ~47,900 rows. This one **does** have genuine old lossy data.

**Mechanism B table (`account_events.amount_tao`/`alpha_amount`) — has real
history**: earliest row observed 2023-03-20 (block 74, effectively chain
genesis) — over three years of potentially-lossy data.

**Archive-node reachability, tested live 2026-07-14** (the node is
`--pruning=archive`, `--sync=full`, currently ~57% synced to chain tip,
syncing forward from genesis):

- Block 74 (account_events' oldest row): `chain_getBlockHash` →
  `state_getRuntimeVersion` at that historical hash succeeded, returning a
  real, period-correct result (`specVersion: 101`, an old runtime — proof
  this queried genuine historical state, not a hash-ignoring current-state
  fallback). **Confirmed reachable now** — and since the archive syncs
  forward from genesis and is already well past this point, the entire
  account_events historical range back to block 74 is already reachable.
- subnet_snapshots' earliest date (2025-06-23) corresponds to roughly block
  5.9M (rough extrapolation from the chain's ~2.6M blocks/year cadence) — the
  archive is currently at ~4.9M and hasn't reached that height yet. **Not yet
  reachable**, but on current sync trajectory (see the fullnode/RPC-pool work
  this session) should be within the archive's reach well before it finishes
  syncing to tip.

## Decision

**No-go on a blanket Phase 3 backfill project right now.** Reasoning:

1. Two of the three Mechanism A tables (`neurons`, `neuron_daily`) have no
   recoverable old data at all — the D1 retirement already erased what would
   have needed fixing. There is nothing to build for these.
2. The remaining candidates (`subnet_snapshots.total_stake_tao`,
   `account_events.amount_tao`/`alpha_amount`) are real but per #2923's own
   framing, **today's actual magnitudes are nowhere near the ~9M TAO
   precision ceiling** — the practical impact of leaving old rows
   imprecise is low-order-bit imprecision on historical data, not a
   functionally broken product today.
3. `subnet_snapshots` isn't even fully reachable yet (archive needs ~11 more
   days of sync at current pace to pass the needed block height) — building
   a backfill pipeline against a target that isn't fully queryable yet would
   mean rehearsing against a moving target, an incident-mode this project
   has explicitly tried to avoid before (see #2923's own reference to a
   prior under-verified-assumption incident).
4. A real backfill (state queries or event re-decodes at ~3 years of
   historical block heights, for `account_events` specifically) is a
   genuine multi-day re-derivation project with real correctness risk on a
   10M+ row production table — #2923 itself required staging rehearsal
   before any live execution. That cost isn't justified by a low-impact,
   speculative fix with no concrete downstream consumer asking for it.

## Consequences

- Historical imprecision in `subnet_snapshots.total_stake_tao` (2025-06-23
  onward) and `account_events.amount_tao`/`alpha_amount` (2023-03-20
  onward) is an accepted, documented limitation — not a bug to be
  rediscovered later. `neurons`/`neuron_daily` have no old data at all to be
  imprecise, so they're not a limitation, just a non-issue.
- Both remaining tables are confirmed re-derivable in principle: `subnet_snapshots`
  once the archive node passes ~block 5.9M, `account_events` right now (the
  archive already covers its full range). If a concrete need for a
  corrected historical value ever comes up (e.g. a specific validator's
  historical stake needs verifying for a real dispute or audit), a targeted,
  narrow re-derivation for that specific case is a much smaller, safer
  project than the blanket backfill #2923 originally scoped — do that
  instead of resurrecting the full project.
- #2923 is closed referencing this ADR rather than left open indefinitely.
