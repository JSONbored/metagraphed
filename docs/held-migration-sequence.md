# Held migration source sequence

Applied `0038_raw_capture_publications.sql` keeps its exact filename and SQL.
PR #12620 records application on 2026-10-03 at 00:23:04 UTC. Its SQL SHA256 is
`b8dd7743860c28969602f6b40c0fa776ff18734dd78e43a0752bbb755482e3ac`.
Do not replay its 15,499-row receipt backfill or rename its ledger identity.

| Migration                                       | State                              |
| ----------------------------------------------- | ---------------------------------- |
| `0038_raw_capture_publications.sql`             | Applied; immutable                 |
| `0039_lane_health_retention_trigger_bounds.sql` | New health repair, PR #12721; held |
| `0040_self_stake_snapshot_receipts.sql`         | Never applied; formerly0039        |
| `0041_raw_capture_finality.sql`                 | Never applied; formerly0040        |
| `0042_webhook_delivery_ledger.sql`              | Never applied; formerly0041        |
| `0043_alpha_runtime_snapshots.sql`              | Never applied; formerly0042        |

This branch contains its existing dependency prefix and the identical new health
migration. Never-applied SQL bodies retain their bytes; only filenames and source
references move. PR #12721 must land and qualify the health trigger repair and its
runtime housekeeping fence first. The health change must not import held0040–0043
schemas merely to pass validation. Subsequent drafts must rebase on that qualified
source so the runtime fence remains present.

A main merge starts remote D1 migration application and independent Worker builds;
there is no automatic ordering guarantee. Full native CI, actual physical schema
and storage/recovery qualification, and an exact approved schema/runtime sequence
are still required. This reconciliation authorizes no merge, DDL, capture, cleanup,
backfill, fleet action or deployment. Disposable fixture migration lists exercise
only their functional prerequisites; filenames in this table define the coordinated
production source order. `d1_migrations.name` uses the full filename, not its prefix.
