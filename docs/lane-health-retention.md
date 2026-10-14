# Runtime-first retention qualification

A failed or ambiguous insertion must keep its original acknowledgement. After an
eligible write attempt, housekeeping may run independently without replaying the
capture. Health expiry keeps every latest timestamp tie; both health and burn retain
their existing strict 90-day cutoff. A bounded sweep may leave expired backlog.

## First stage: compatible runtime, no physical migration

This candidate changes runtime and tests only. All active `migrations/d1` files and
both physical snapshots are byte-identical to its main base. It adds no production
migration, physical-schema assertion, deletion fence, observer or controller.
`tests/fixtures/lane-health-retention-trigger-bounds.sql` is disposable native test
input: the exact reviewed future trigger repair, outside the active migration path.
Native regressions exercise both the old schema and that prospective repair.

The D1 health store checks six actual SQLite trigger definitions once per store
instance. Missing, changed, duplicate or unreadable definitions disable cleanup
without changing insertion acknowledgement. On the old schema a 50-row packet
attempts 50 inserts and one metadata query, with no health deletion. After the exact
repair, a fresh store permits up to 20 health deletions per attempt: at most 1,000
in that packet, with 101 database calls. Every latest timestamp tie is preserved.
The cache is scoped to the store, not the isolate. An instance that read false stays
conservatively disabled through a concurrent migration; the next instance rechecks.
PostgreSQL has no D1 trigger dependency and uses bounded native `ctid` cleanup.

Burn cleanup is independent of this health readiness check. The first approved
runtime publication therefore permits up to 2,000 expired burn observations per
valid nonempty natural capture attempt, including a failed or ambiguous write.
`pruned: true` means one bounded sweep completed, not that the backlog is empty.
Missing bindings and invalid/empty upstream reads still do no cleanup. This is an
ongoing destructive effect requiring explicit approval in the first stage. If that
approval is withheld, defer the burn runtime change; do not infer that it is gated
by health metadata or add a staging controller.

## Native delivery and second stage

A runtime-only merge matching none of `.github/workflows/d1-maintenance.yml`'s push
paths does not start its migration application. Its weekly scheduled run is
verification-only. The merge still publishes the four public Workers through their
independent native builds, runs full validation and contract sync. A contract-sync
bot PR can be PAT-merged after checks and cause additional main-triggered effects.
No private poller or decoder Container promotion is included.

After separately approved runtime publication, verify every relevant selected
Worker version and actual store bindings. Selected deployment percentages alone do
not prove old HTTP, scheduled, queue or Durable Object invocations have completed.
Old code can retain its pre-existing unbounded cleanup during rollout. New burn
cleanup may free space and let an old health insertion succeed, exposing that old
cleanup while versions overlap. A strict zero-old-writer guarantee requires native
quiescence evidence; no arbitrary fixed wait or new persistent fence is implied.

Prepare a second schema candidate on that compatible runtime baseline. Preserve
exact already-applied `0038_raw_capture_publications.sql` and add only the reviewed
`0039_lane_health_retention_trigger_bounds.sql`, promoting the fixture's exact SQL
bytes to their canonical owner. Check the complete bounded ledger filename set
against the active candidate files so 0039 is the sole pending unit. Do not import
unapplied self-stake, finality, webhook or Alpha schemas just to pass a validator.

With separate DDL and health-expiry approval, dispatch the existing native tracked
migration owner against that schema branch before its main merge. Wrangler skips
exact tracked 0038 and applies 0039. The repair replaces three triggers and creates
five using existing indexes, without a history rewrite. Health cleanup becomes
eligible as soon as all six actual hashes match; no separate release flag exists.
The native tests compare populated current/clock/verdict projections to history
through ties, moves, middle/multirow/final deletion and rollback, including reversed
update-trigger installation order and failed DDL-batch rollback.

The first verify-only physical snapshot check after application may report expected
drift. Do not mistake that result for unapplied DDL or retry blindly. Capture the
actual steady schema once, commit it into that same schema draft, and qualify its
final head. Merge only after exact physical and ledger verification; main's native
maintenance must then skip tracked 0038/0039 and verify the real committed capture.
Worker builds run again with compatible runtime. No intermediate fenced schema or
fence-removal merge is needed. This is two main merges and one actual post-DDL
capture in the normal path, with no new persistent gate infrastructure.

## Immutable identities and remaining limits

PR #12620 records 0038 applied on October 3, 2026 at 00:23:04 UTC with 15,499
publication receipts backfilled. Its exact 1,434-byte SQL SHA256 is
`b8dd7743860c28969602f6b40c0fa776ff18734dd78e43a0752bbb755482e3ac`.
Its full filename and SQL remain immutable; omitting that addition from the first
runtime candidate does not rename, undo or replay an applied migration.

| Unit                  | Coordinated identity | Application state                       |
| --------------------- | -------------------- | --------------------------------------- |
| Publication receipts  | 0038                 | Applied; unchanged                      |
| Health trigger repair | 0039                 | Future separately approved schema stage |
| Self-stake receipts   | 0040                 | Never applied; held                     |
| Raw finality          | 0041                 | Never applied; held                     |
| Webhook ledger        | 0042                 | Never applied; held                     |
| Alpha snapshots       | 0043                 | Never applied; held                     |

Near-full D1 can still refuse DDL or cleanup allocation; reserved raw bytes do not
prove writable or reclaimable space. No denied PRAGMA, heavy census, raw drain,
manual replay, purchase or portable-owner cutover is authorized here. If interrupted
before the schema stage, health cleanup remains disabled while inserts retain their
truthful result. Keep the native release record explicitly pending and resume with
actual ledger/hash verification. Fresh health timestamps do not prove expiry is on.

Source rollback cannot restore expired health or burn observations. Retain the
compatible health runtime and optimized triggers where possible. Selecting an old
runtime after the repair reintroduces its unbounded cleanup; reverse DDL during a
true cached store can also expose old trigger work. Those are separately reviewed
rollback transitions, not automatic recovery. Raw originals, publication receipts,
retained blocks and permanent daily history are unchanged.
