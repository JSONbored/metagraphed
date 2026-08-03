-- The validator-nominator-counts family on D1 (box decommission, the
-- #9146/#9157 pattern applied to the last frozen sync lane).
--
-- WHY THIS LANE WAS DEAD RATHER THAN MERELY MIGRATED. Its producer -- a full
-- SubtensorModule::Alpha scan -- was already ported off the box into the
-- poller Container (metagraphed-infra's
-- src/bin/poller/jobs/validator_nominators.rs), but that job writes straight
-- to Postgres, so it is one of the five lanes Dockerfile.poller leaves
-- disabled "until they have a Cloudflare-native sink". This table is that
-- sink. The scan itself needs no rehosting; only its write target does.
--
-- Latest-only, upserted on (hotkey) with the same
-- `captured_at <= excluded.captured_at` staleness guard every other D1 sync
-- lane uses. NO history table: a nominator count is a live gauge, not a fact
-- worth diffing over time (handleValidatorNominatorCountsSync's own header
-- made this call, and nothing about the D1 port changes it).
--
-- NO PRUNE, deliberately -- and for a DIFFERENT reason than account_identity's
-- in 0009. There, a missing account might simply not have been observed. Here
-- the producer's pass over Alpha is exhaustive by construction, so a hotkey
-- absent from a batch genuinely has no stake entries at all. That would argue
-- FOR a prune, except the producer chunks its batches (the sync route caps
-- rows per request), so "absent from this batch" and "absent from the scan"
-- are not the same statement and only the latter licenses a delete. Upsert-only
-- also matches what handleValidatorNominatorCountsSync did against Postgres,
-- so the port changes the store and nothing else.
--
-- Type translation follows 0007_neurons.sql's conventions: counts -> INTEGER,
-- captured_at -> INTEGER epoch-ms, hotkey (SS58) -> TEXT.
--
-- The column set is NOT transcribed by hand: it is exactly the list the writer
-- binds, VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS
-- (src/validator-nominator-summary.ts).
-- tests/validator-nominator-counts-d1-write.test.ts asserts that
-- correspondence in both directions -- the same anti-drift guarantee as 0007's
-- tests/neurons-d1-schema.test.ts and 0011's own.
--
-- SIZE: 112,550 rows live-measured against the lakehouse mirror of this same
-- table (2026-08-03), one row per distinct hotkey ever seen holding stake --
-- far wider than the ~1,031 hotkeys that currently carry a validator permit,
-- because every nominated hotkey is scanned, not just permitted ones.
CREATE TABLE IF NOT EXISTS validator_nominator_counts (
  hotkey          TEXT    NOT NULL,
  nominator_count INTEGER NOT NULL,
  captured_at     INTEGER NOT NULL,
  PRIMARY KEY (hotkey)
);
