-- Block explorer block depth (#1817): store the runtime spec_version for each
-- block so developers can determine which runtime version was active for any
-- given block range, debug historical transactions against the correct schema,
-- and filter/annotate by runtime era.
--
-- spec_version is the `specVersion` from get_block_runtime_version(). Nullable:
-- best-effort only — the field is null when the RPC call fails or the block is
-- pruned. Applied as an idempotent ALTER (nullable column never breaks existing
-- rows or the INSERT OR IGNORE load path).

ALTER TABLE blocks ADD COLUMN spec_version INTEGER;
