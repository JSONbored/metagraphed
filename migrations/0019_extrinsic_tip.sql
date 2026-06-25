-- Block explorer extrinsic depth (#1855): store the priority tip paid per
-- extrinsic, separate from the inclusion fee (#1815/0016). A tip is the extra
-- amount a signer pays ON TOP of the base fee to prioritize inclusion — it is
-- NOT part of fee_tao, so detail pages and future fee analytics can show both.
--
-- tip_tao is `attrs[2]` (the `tip` field) of TransactionPayment.TransactionFeePaid
-- — the same event the poller already reads for fee_tao — converted rao→TAO.
-- Nullable: unsigned/tip-free extrinsics store null. Applied as a plain nullable
-- ALTER (never breaks existing rows or the INSERT OR IGNORE load path), mirroring
-- 0016. INSERT OR IGNORE means already-loaded rows are not backfilled; tip_tao
-- populates going forward only. Apply to prod via
-- `wrangler d1 execute metagraphed-health --remote --yes --file=migrations/0019_extrinsic_tip.sql`
-- (NEVER `wrangler d1 migrations apply` — the tracking table is out of sync).

ALTER TABLE extrinsics ADD COLUMN tip_tao REAL;
