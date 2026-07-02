-- Block explorer extrinsic depth (#1819): add decoded call arguments to the
-- `extrinsics` table so per-extrinsic detail pages can show what a call actually
-- did (destination, amount, etc.), not just the pallet/function name.
--
-- call_args is a JSON-encoded string of the decoded call arguments as emitted by
-- substrate-interface. Nullable: inherents/unsigned extrinsics and any extrinsic
-- where decode fails store null. Applied as an idempotent ALTER (nullable column
-- never breaks existing rows or the INSERT OR IGNORE load path).

ALTER TABLE extrinsics ADD COLUMN call_args TEXT;
