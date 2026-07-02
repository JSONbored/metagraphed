-- Block explorer chain hierarchy (#1849): link each account_events row back to the
-- extrinsic that emitted it, so extrinsic detail can embed its events and "which
-- extrinsic caused this StakeAdded" becomes answerable.
--
-- extrinsic_index is the 0-based index of the emitting extrinsic within the block,
-- read from the event's phase=ApplyExtrinsic by the chain poller (the same
-- extrinsic_idx already used to correlate fee/success). Nullable: Initialization /
-- Finalization phase events store null, and all pre-migration rows are null
-- (the link only populates going forward).
--
-- Applied as an idempotent ALTER (nullable column never breaks existing rows or the
-- INSERT OR IGNORE load path). The reverse-lookup index serves the extrinsic-detail
-- embed (SELECT ... WHERE block_number = ? AND extrinsic_index = ?).

ALTER TABLE account_events ADD COLUMN extrinsic_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_account_events_extrinsic ON account_events (block_number, extrinsic_index);
