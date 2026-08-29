-- Precompute the compact economic footprint served on block explorer rows.
--
-- Values remain exact decimal text at rest. They are derived from the same
-- completed chain-detail batch whose coverage row vouches for the block, so a
-- missing hot-detail row is visibly `pending` and an older pre-migration row
-- is visibly `unavailable`; neither can be mistaken for a measured zero.
ALTER TABLE public.chain_detail_blocks
  ADD COLUMN IF NOT EXISTS native_transfer_tao text,
  ADD COLUMN IF NOT EXISTS stake_flow_tao text,
  ADD COLUMN IF NOT EXISTS economic_activity_tao text,
  ADD COLUMN IF NOT EXISTS fee_tao text,
  ADD COLUMN IF NOT EXISTS tip_tao text,
  ADD COLUMN IF NOT EXISTS issuance_tao text,
  ADD COLUMN IF NOT EXISTS subnet_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS economics_complete boolean NOT NULL DEFAULT false;
