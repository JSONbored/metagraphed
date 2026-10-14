# Lane-health retention qualification

Lane verdicts and burn observations retain their existing strict 90-day cutoff.
Housekeeping runs independently after a write attempt; a failed or ambiguous write
stays unconfirmed even when cleanup succeeds. There is no automatic capture replay.
Lane expiry preserves every latest-timestamp observation and severity tie. A bounded
sweep can leave expired backlog; burn `pruned: true` means that sweep completed.

## Native projection work

D1 migration `0043_lane_health_retention_trigger_bounds.sql` replaces the deletion
and move triggers introduced by `0003`. It uses the existing clock timestamp primary
key to locate one successor, following `0003`'s insert pattern. It refreshes an old
verdict projection only when its last observation at the selected timestamp goes
away, then reads the remaining newest timestamp through `idx_lane_health_verdict`.
The guarded selected-current trigger from `0002` is unchanged. No new index or data
rewrite is needed. Native regression tests compare projections against retained
history after duplicate timestamps, moves, updates, middle/multirow/last-row deletion
and rollback, including reversed installation order for the update triggers.

A direct deletion cap alone did not bound work with the old triggers: 20 deletions
against 130,000 retained observations read 3,466,594 rows and wrote 100 rows. The
receiver awaits up to 50 insert/cleanup pairs before acknowledging a packet. Native
CI therefore compares old and replacement trigger work for individual sweeps and
complete 50-row successful and rejected packets, measuring the whole request and
checking exact acknowledgement receipts. Rejected SQL statements do not return D1
row counters; their call counts and full request time are measured, while their
unreported reads/writes are not invented. Timing is fixture evidence, not a production
latency promise. PostgreSQL has no D1 clock/verdict projection triggers; its native
row-identity retention and partial/lost acknowledgement semantics remain tested with
actual PostgreSQL execution.

## Held migration sequence

The default branch currently ends at `0037`. Numbers `0038` through `0042` already
belong to held source preparations, carried unchanged here from public PR #12709
at `76dca0e8fbbf8de310e03115ed8233444946d29c`:

- `0038_raw_capture_publications.sql`
- `0039_self_stake_snapshot_receipts.sql`
- `0040_raw_capture_finality.sql`
- `0041_webhook_delivery_ledger.sql`
- `0042_alpha_runtime_snapshots.sql`

They are included only to preserve the repository's unique, gap-free migration
sequence. `0043` functionally depends on health migrations `0001`–`0003`, not these
other table families. Health-only native fixtures demonstrate that distinction.
No applied historical migration is edited. Inclusion does not qualify or authorize
physical application of the held prerequisites. A future integration must reconcile
the ordered source sequence and review each prerequisite's independent qualification
and deployment hold before any physical DDL. Do not apply this source-only candidate
or bulk-apply its directory as a recovery action.

Production rollout remains held. D1 allocation/headroom and current projection
parity are not established by disposable CI databases. This change does not drain
raw captures, prune permanent daily history or remove raw-rollup prerequisites.
