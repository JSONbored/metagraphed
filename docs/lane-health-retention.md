# Lane-health retention qualification

Lane verdicts and burn observations retain their existing strict 90-day cutoff.
Housekeeping runs independently after a write attempt; a failed or ambiguous write
stays unconfirmed even when cleanup succeeds. There is no automatic capture replay.
Lane expiry preserves every latest-timestamp observation and severity tie. A bounded
sweep can leave expired backlog; burn `pruned: true` means that sweep completed.

## Native projection work

D1 migration `0039_lane_health_retention_trigger_bounds.sql` replaces the deletion
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

## Applied identity and held migration sequence

Default-branch filenames are not an application ledger. PR #12620's retained
receipt records `0038_raw_capture_publications.sql` applied on October 3, 2026 at
00:23:04 UTC, with 15,499 publication receipts backfilled. Its final SQL at
`cce024cab60e8852c8eab01b028d797bb8acb20c` is 1,434 bytes, SHA256
`b8dd7743860c28969602f6b40c0fa776ff18734dd78e43a0752bbb755482e3ac`.
Keep that exact filename and SQL. The actual 269-object snapshot from that head
adds only `raw_capture_publications` to the previous 268 unchanged objects; it is
restored here as retained physical evidence, not a hypothetical future schema.

The source sequence reserves health `0039` and shifts only never-applied held
units. The publication-receipt draft and applied `0038` are unchanged:

| Filename                                        | Application state              |
| ----------------------------------------------- | ------------------------------ |
| `0038_raw_capture_publications.sql`             | Applied; immutable             |
| `0039_lane_health_retention_trigger_bounds.sql` | New health repair; held        |
| `0040_self_stake_snapshot_receipts.sql`         | Never applied; formerly `0039` |
| `0041_raw_capture_finality.sql`                 | Never applied; formerly `0040` |
| `0042_webhook_delivery_ledger.sql`              | Never applied; formerly `0041` |
| `0043_alpha_runtime_snapshots.sql`              | Never applied; formerly `0042` |

The health candidate contains only applied `0038` and new `0039`; no held self-stake,
finality, webhook or Alpha DDL is imported to pass a validator. The other owned draft
stacks must carry the same health dependency and only rename their never-applied
migration files/references, preserving SQL bodies. `d1_migrations.name` is the unique
full filename; duplicate numeric prefixes are an ordering conflict, not necessarily
a ledger uniqueness failure. A future preflight must verify the existing exact
`0038` ledger name and physical table before Wrangler is authorized, so it skips the
already-applied file instead of replaying the backfill.

## Physical trigger fence and native rollout

A main merge starts `.github/workflows/d1-maintenance.yml`'s remote tracked
migration application and independent Cloudflare Worker builds. There is no native
ordering between them. A merge therefore authorizes physical DDL and publishing
Workers, and cannot be described as a source-only action.

The D1 store lazily queries `sqlite_master` once per store/request and checks SHA256
of the six relevant actual trigger definitions using the physical snapshot's
normalization. A missing, changed, duplicate or unreadable definition disables
housekeeping. It does not trust only the ledger, replay an insertion or override
its acknowledgement. Readiness remains conservative for that request; a new
request rechecks, without a global isolate cache. The extra metadata call makes a
ready 50-row packet 101 serial calls. Native tests run the actual receiver before
DDL (no cleanup, original success/failure receipt), then after DDL (bounded cleanup),
and compare the hashes with actual SQLite definitions. Previously retained full
old-trigger packet measurements remain baseline evidence; the guarded receiver no
longer executes that expensive baseline merely for measurement.

Production rollout remains held. The trigger-first sequence is concrete:

1. Obtain separately scoped approval for the necessary bounded primary-ledger,
   physical-definition, headroom and projection-parity acceptance. Existing receipts
   do not prove present production free space or parity. Verify exact applied0038,
   absent0039, the six trigger definitions and that pending files contain only0039.
2. With the old main Worker still selected, run the existing native tracked migration
   command at this exact reviewed branch: `npm run migrate:d1 -- --remote`.
   The existing D1-maintenance workflow supports `workflow_dispatch` against that
   branch; do not merge to main as the first DDL operation. Wrangler must skip the
   already-tracked full0038 filename and apply only0039. The application replaces
   three triggers and creates five; it neither rewrites history nor adds indexes.
3. Capture the actual resulting schema with the existing credentialed
   `snapshot:d1-schema -- --write` owner, review only the expected trigger delta,
   commit that real capture and requalify the final source through full native CI.
   The first maintenance run's verify-only step will report drift against the old
   physical snapshot after DDL; that is an incomplete rollout, not a successful
   acceptance or a waived guard. Preserve its exact application receipt and do not
   replay an ambiguous write. No prospective snapshot may substitute for this step.
4. Only after exact physical hashes, ledger, headroom/parity and full CI acceptance,
   obtain approval for the main merge and its automatic Worker publishing/retention
   effects. Main's maintenance run must now skip both tracked0038 and0039 and verify
   the real committed snapshot. Worker builds still run independently; actual
   trigger readiness additionally prevents cleanup against old/partial definitions.
5. The new runtime permits at most20 health deletions per natural write attempt
   (at most1000 in a50-row packet) and2000 burn-history deletions per valid nonempty
   capture attempt. This includes failed/ambiguous inserts, preserves latest health
   ties and acknowledges original writes truthfully. These are ongoing destructive
   retention effects requiring explicit approval, not merely harmless metadata work.
   Observe the existing natural ticks and their receipts first; a manually triggered
   acceptance packet or additional production query needs its own stated scope.

Disposable CI is not production headroom or parity evidence. The source patch alone
authorizes none of these production steps.

Rollback should first use the prior Worker while retaining compatible optimized
triggers. Expired history cannot be recovered by source rollback. Any separately
approved reverse DDL must first stop new cleanup and drain in-flight requests;
preserve applied `0038`, publication receipts and all ledger identities. Use a new
forward repair migration for later schema correction, rather than deleting or
reusing a tracked filename. This source change performs no raw drain, permanent
daily-history pruning or removal of raw-rollup prerequisites.
