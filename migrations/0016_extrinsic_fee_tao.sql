-- Block explorer extrinsic depth (#1815): store the fee paid per extrinsic so
-- detail pages can show exact cost and network-wide fee analytics can be
-- derived (total fees per block, fee trends over time).
--
-- fee_tao is the `actual_fee` from TransactionPayment.TransactionFeePaid,
-- converted from rao to TAO. Nullable: inherents and extrinsics that do not
-- pay a fee store null. Applied as an idempotent ALTER (nullable column never
-- breaks existing rows or the INSERT OR IGNORE load path).

ALTER TABLE extrinsics ADD COLUMN fee_tao REAL;
