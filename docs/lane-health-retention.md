# Lane-health retention qualification

Lane verdicts and burn observations retain their existing strict 90-day cutoff.
Housekeeping runs independently after a write attempt; a failed or ambiguous write
stays unconfirmed even when cleanup succeeds. There is no automatic capture replay.
Lane expiry preserves every latest-timestamp observation and severity tie. A bounded
sweep can leave expired backlog; burn `pruned: true` means that sweep completed.

## Native projection work

D1 migration `0038_lane_health_retention_trigger_bounds.sql` replaces the deletion
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

The native trigger prototype reduced a 20-row sweep on 130,000 observations from
3,466,594 reads to 221 reads, without a new index. A successful 50-row packet fell
from 175,351,767 reads to 11,250 reads. It still performs 100 serial database calls
and wrote 5,300 rows in that fixture; these remaining costs are not hidden by the
read improvement. The final candidate's native run records its own measurements.

## Migration sequence coordination

The default branch currently ends at `0037`; this standalone health migration
therefore uses the next prefix, `0038`. It functionally depends only on health
migrations `0001`–`0003`. No applied historical migration is edited and no unrelated
held schema is carried into this candidate. The generated physical schema snapshot
is unchanged; the live-schema guard must continue to report genuinely absent tables.

Held public PR #12709 currently carries another `0038` through `0042` at
`76dca0e8fbbf8de310e03115ed8233444946d29c`:

- `0038_raw_capture_publications.sql`
- `0039_self_stake_snapshot_receipts.sql`
- `0040_raw_capture_finality.sql`
- `0041_webhook_delivery_ledger.sql`
- `0042_alpha_runtime_snapshots.sql`

These prospective numbers conflict with this candidate. Before merging either
source sequence, coordinate a rebase and ordered renumbering across the held PRs:
if health goes first, shift that entire held sequence to `0039`–`0043` while
preserving its relative dependency order; if the held sequence goes first, rebase
and number this health migration `0043`. Do not rename already-applied migrations.
This candidate does not modify the other drafts or authorize application of their
DDL. Native tests apply only the health prerequisites and this new migration.

Production rollout remains held. D1 allocation/headroom and current projection
parity are not established by disposable CI databases. This change does not drain
raw captures, prune permanent daily history or remove raw-rollup prerequisites.
