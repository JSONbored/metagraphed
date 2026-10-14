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

Production rollout remains held. Current main still runs **unbounded** cleanup
following a successful insert. Applying faster triggers while that runtime is
selected does not make those old sweeps bounded. The concrete trigger-first
proposal therefore includes independent native deletion fences:

1. Obtain separately scoped approval for bounded primary-ledger, physical-definition,
   headroom and projection-parity acceptance. Verify exact applied0038, absent0039,
   the six trigger definitions and a pending file set containing only0039. Existing
   receipts do not establish present free space or parity.
2. Install the two `BEFORE DELETE` fences in
   `tests/fixtures/retention-release-fences.json` on `lane_health` and
   `subnet_burn_history`, then verify their actual definitions. They deliberately
   abort both old unbounded and new bounded cleanup, while inserts/updates keep their
   truthful acknowledgements. They also catch an old writer's later cleanup after
   its earlier insert; writes already completed before fence installation cannot be
   undone. Native CI verifies both old-shaped deletes are refused and original
   health/burn writes remain acknowledged.
3. With deletion fenced and the old main Workers still selected, run the existing
   native tracked migration command at this exact reviewed branch:
   `npm run migrate:d1 -- --remote`. D1-maintenance supports `workflow_dispatch`
   against that branch; do not merge to main as the first DDL operation. Wrangler
   must skip the already-tracked full0038 filename and apply only0039. The migration
   replaces three triggers and creates five; it does not rewrite history or add
   indexes. Keep both operational fences installed.
4. Capture the actual schema with the existing credentialed
   `snapshot:d1-schema -- --write` owner, review only the expected trigger delta and
   two fences, commit that real capture and requalify through full native CI. The
   initial maintenance verify-only step will report drift against the old snapshot;
   that is an incomplete rollout, not acceptance or a waived guard. Preserve the
   exact application receipt and do not replay an ambiguous write. No prospective
   snapshot may substitute for actual introspection.
5. After physical definitions/ledger/headroom/parity and full CI acceptance, approve
   the main merge and its automatic Worker publication. Main's maintenance now skips
   tracked0038 and0039 and verifies the real fenced snapshot. Worker builds run
   independently. Verify **every** affected selected Worker is the new compatible
   runtime before proceeding; the deletion fences remain in place throughout.
6. Only then, under explicit destructive-retention approval, drop the two fences
   using the exact release statements in the fixture. This enables at most20 health
   deletions per natural attempt (1000 in a50-row packet) and2000 burn deletions per
   valid nonempty capture attempt, including failed/ambiguous inserts. Observe
   natural ticks first. Capture the actual final schema without the two fences,
   commit/requalify that snapshot and reconcile main through the same native path;
   that source merge again triggers maintenance verification and independent Worker
   builds. No manually triggered packet or extra production query is implicit.

These fences are an unexecuted operational proposal, not an applied migration or a
new serving owner. They add two temporary trigger objects and require two reviewed
physical snapshots (fenced and released); account for both source merges' automatic
side effects. Do not omit their installation and assume an old successful writer
cannot prune. Until the new runtime is selected, retaining the fences is the safe
hold. Rolling back to the old runtime after release requires reinstalling deletion
fences first, because its old successful-write cleanup is unbounded.

Disposable CI is not production headroom or parity evidence. The source patch alone
authorizes none of these production steps.

Rollback should first use the prior Worker while retaining compatible optimized
triggers. Expired history cannot be recovered by source rollback. Any separately
approved reverse DDL must first stop new cleanup and drain in-flight requests;
preserve applied `0038`, publication receipts and all ledger identities. Use a new
forward repair migration for later schema correction, rather than deleting or
reusing a tracked filename. This source change performs no raw drain, permanent
daily-history pruning or removal of raw-rollup prerequisites.
