-- Internal finalized observations only; no producer or published current view.
-- v454 types: subtensor 14cde6410fe8ec81a940e290c56f94a632a0988d.
-- Unconstrained NUMERIC is intentional: NUMERIC(p,0) rounds fractional input
-- BEFORE a CHECK sees it. These domains reject rather than round fractions.
DO $$ BEGIN
CREATE DOMAIN root_basket_u64 AS NUMERIC
  CHECK (VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 18446744073709551615);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE DOMAIN root_basket_u128 AS NUMERIC
  CHECK (VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 340282366920938463463374607431768211455);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE DOMAIN root_basket_i128 AS NUMERIC
  CHECK (VALUE = trunc(VALUE) AND VALUE >= -170141183460469231731687303715884105728 AND VALUE <= 170141183460469231731687303715884105727);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE DOMAIN root_basket_u32 AS NUMERIC
  CHECK (VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 4294967295);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE DOMAIN root_basket_u16 AS NUMERIC
  CHECK (VALUE = trunc(VALUE) AND VALUE >= 0 AND VALUE <= 65535);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
CREATE DOMAIN root_basket_hash32 AS TEXT
  CHECK (VALUE ~ '^0x[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS root_basket_captures (
  capture_id UUID PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('finney', 'test', 'local')),
  network_genesis_hash root_basket_hash32 NOT NULL,
  finalized_block_hash root_basket_hash32 NOT NULL,
  finalized_block root_basket_u64 NOT NULL,
  runtime_spec_version root_basket_u32 NOT NULL CHECK (runtime_spec_version = 454),
  runtime_api_version root_basket_u16 NOT NULL CHECK (runtime_api_version = 3),
  decoder_version TEXT NOT NULL CHECK (decoder_version = 'subtensor-v454-14cde641-v1'),
  metadata_sha256 root_basket_hash32 NOT NULL,
  started_at_ms root_basket_u64 NOT NULL,
  finished_at_ms root_basket_u64 NOT NULL CHECK (finished_at_ms >= started_at_ms),
  expected_pages root_basket_u32 NOT NULL CHECK (expected_pages > 0),
  expected_funds root_basket_u32 NOT NULL,
  index_status TEXT NOT NULL CHECK (index_status IN ('published', 'not_published')),
  index_completed_block root_basket_u64,
  bag_index_q64_bits root_basket_u128 NOT NULL,
  stake_index_q64_bits root_basket_u128 NOT NULL,
  CHECK (
    (index_status = 'published' AND index_completed_block IS NOT NULL AND index_completed_block <= finalized_block)
    OR (index_status = 'not_published' AND index_completed_block IS NULL
      AND bag_index_q64_bits = 18446744073709551616 AND stake_index_q64_bits = 18446744073709551616)
  ),
  UNIQUE (network_genesis_hash, finalized_block_hash, decoder_version)
);
CREATE INDEX IF NOT EXISTS root_basket_captures_history
  ON root_basket_captures (network_genesis_hash, finalized_block DESC);

-- Source manifest counts are expectations, not a persisted-completeness stamp.
-- A future writer must verify receipts/children before publishing any capture.
CREATE TABLE IF NOT EXISTS root_basket_capture_pages (
  capture_id UUID NOT NULL REFERENCES root_basket_captures (capture_id),
  page_index root_basket_u32 NOT NULL,
  start_after root_basket_hash32,
  next_after root_basket_hash32,
  response_sha256 root_basket_hash32 NOT NULL,
  fund_count root_basket_u16 NOT NULL CHECK (fund_count <= 256),
  PRIMARY KEY (capture_id, page_index),
  CHECK ((page_index = 0) = (start_after IS NULL)),
  CHECK (start_after IS NULL OR next_after IS NULL OR start_after <> next_after)
);
CREATE UNIQUE INDEX IF NOT EXISTS root_basket_capture_page_cursors
  ON root_basket_capture_pages (capture_id, start_after) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS root_basket_capture_terminal_page
  ON root_basket_capture_pages (capture_id) WHERE next_after IS NULL;

CREATE OR REPLACE FUNCTION root_basket_preserve_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'root basket receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS root_basket_receipt_immutable ON root_basket_capture_pages;
CREATE TRIGGER root_basket_receipt_immutable
  BEFORE UPDATE ON root_basket_capture_pages
  FOR EACH ROW EXECUTE FUNCTION root_basket_preserve_receipt();

CREATE TABLE IF NOT EXISTS root_basket_fund_snapshots (
  capture_id UUID NOT NULL,
  hotkey root_basket_hash32 NOT NULL,
  page_index root_basket_u32 NOT NULL,
  shares_atomic root_basket_u64 NOT NULL CHECK (shares_atomic > 0),
  spot_nav_rao root_basket_u64 NOT NULL,
  realizable_nav_rao root_basket_u64 NOT NULL,
  deposited_rao root_basket_u64 NOT NULL,
  redeemed_rao root_basket_u64 NOT NULL,
  raw_spot_price_q64_bits root_basket_u128 NOT NULL,
  display_price_q64_bits root_basket_u128 NOT NULL,
  display_shares_q64_bits root_basket_u128 NOT NULL,
  stake_price_q64_bits root_basket_u128 NOT NULL,
  staker_twr_q64_bits root_basket_u128 NOT NULL,
  pending_entitlement_q64_bits root_basket_u128 NOT NULL,
  provisional BOOLEAN NOT NULL,
  first_block root_basket_u64 NOT NULL,
  price_divisor_q64_bits root_basket_u128,
  rate0_q32_bits root_basket_i128,
  tr_splice_q64_bits root_basket_u128,
  holdings_count root_basket_u32 NOT NULL,
  targets_count root_basket_u32 NOT NULL,
  PRIMARY KEY (capture_id, hotkey),
  FOREIGN KEY (capture_id, page_index) REFERENCES root_basket_capture_pages (capture_id, page_index),
  CHECK (
    (provisional AND first_block = 0 AND price_divisor_q64_bits IS NULL AND rate0_q32_bits IS NULL AND tr_splice_q64_bits IS NULL)
    OR (NOT provisional AND first_block > 0 AND price_divisor_q64_bits IS NOT NULL AND price_divisor_q64_bits > 0
      AND rate0_q32_bits IS NOT NULL AND tr_splice_q64_bits IS NOT NULL AND tr_splice_q64_bits > 0)
  )
);
CREATE INDEX IF NOT EXISTS root_basket_fund_address_history
  ON root_basket_fund_snapshots (hotkey, capture_id);

CREATE TABLE IF NOT EXISTS root_basket_holdings (
  capture_id UUID NOT NULL,
  hotkey root_basket_hash32 NOT NULL,
  netuid root_basket_u16 NOT NULL,
  quantity_atomic root_basket_u64 NOT NULL,
  quantity_unit TEXT NOT NULL,
  spot_value_rao root_basket_u64 NOT NULL,
  realizable_value_rao root_basket_u64 NOT NULL,
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey),
  CHECK ((netuid = 0 AND quantity_unit = 'rao') OR (netuid > 0 AND quantity_unit = 'alpha_atomic'))
);
CREATE TABLE IF NOT EXISTS root_basket_targets (
  capture_id UUID NOT NULL,
  hotkey root_basket_hash32 NOT NULL,
  netuid root_basket_u16 NOT NULL,
  weight root_basket_u16 NOT NULL,
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey)
);
