-- Block explorer extrinsic depth (#1855): store the priority tip per extrinsic so
-- detail pages can show it alongside the inclusion fee, and tip-based analytics
-- become possible.
--
-- tip_tao is the `tip` (3rd field) from TransactionPayment.TransactionFeePaid,
-- converted from rao to TAO. Separate from fee_tao (the inclusion fee). Nullable:
-- inherents, unsigned extrinsics, and the common no-tip case store null/0. Applied
-- as an idempotent ALTER (nullable column never breaks existing rows or the
-- INSERT OR IGNORE load path) — populates going forward only.

ALTER TABLE extrinsics ADD COLUMN tip_tao REAL;
