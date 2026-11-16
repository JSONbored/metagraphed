-- Load the complete Root basket source family before activating foreign keys
-- and trigger effects. Decimal counters retain their canonical source text.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.root_basket_captures (
  content_sha256 text COLLATE "C" NOT NULL CHECK(length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) !~ '[^0-9a-f]'),
  capture_id text COLLATE "C" NOT NULL PRIMARY KEY CHECK(length(capture_id) = 36),
  network text COLLATE "C" NOT NULL CHECK (network IN ('finney', 'test', 'local')),
  network_genesis_hash text COLLATE "C" NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) !~ '[^0-9a-f]')),
  finalized_block_hash text COLLATE "C" NOT NULL CHECK(finalized_block_hash IS NULL OR (length(finalized_block_hash) = 66 AND substr(finalized_block_hash,1,2) = '0x' AND substr(finalized_block_hash,3) !~ '[^0-9a-f]')),
  finalized_block text COLLATE "C" NOT NULL CHECK(finalized_block IS NULL OR ((finalized_block = '0' OR (finalized_block ~ '^[1-9][0-9]*$')) AND (length(finalized_block), finalized_block) <= (20, '18446744073709551615'))),
  runtime_spec_version bigint NOT NULL CHECK (runtime_spec_version = 454) CHECK(runtime_spec_version BETWEEN 0 AND 4294967295),
  runtime_api_version bigint NOT NULL CHECK (runtime_api_version = 3) CHECK(runtime_api_version BETWEEN 0 AND 65535),
  decoder_version text COLLATE "C" NOT NULL CHECK (decoder_version = 'subtensor-v454-14cde641-v1'),
  metadata_sha256 text COLLATE "C" NOT NULL CHECK(metadata_sha256 IS NULL OR (length(metadata_sha256) = 66 AND substr(metadata_sha256,1,2) = '0x' AND substr(metadata_sha256,3) !~ '[^0-9a-f]')),
  started_at_ms text COLLATE "C" NOT NULL CHECK(started_at_ms IS NULL OR ((started_at_ms = '0' OR (started_at_ms ~ '^[1-9][0-9]*$')) AND (length(started_at_ms), started_at_ms) <= (20, '18446744073709551615'))),
  finished_at_ms text COLLATE "C" NOT NULL CHECK ((length(finished_at_ms), finished_at_ms) >= (length(started_at_ms), started_at_ms)) CHECK(finished_at_ms IS NULL OR ((finished_at_ms = '0' OR (finished_at_ms ~ '^[1-9][0-9]*$')) AND (length(finished_at_ms), finished_at_ms) <= (20, '18446744073709551615'))),
  expected_pages bigint NOT NULL CHECK (expected_pages > 0) CHECK(expected_pages BETWEEN 0 AND 4294967295),
  expected_funds bigint NOT NULL CHECK(expected_funds BETWEEN 0 AND 4294967295),
  index_status text COLLATE "C" NOT NULL CHECK (index_status IN ('published', 'not_published')),
  index_completed_block text COLLATE "C" CHECK(index_completed_block IS NULL OR ((index_completed_block = '0' OR (index_completed_block ~ '^[1-9][0-9]*$')) AND (length(index_completed_block), index_completed_block) <= (20, '18446744073709551615'))),
  bag_index_q64_bits text COLLATE "C" NOT NULL CHECK(bag_index_q64_bits IS NULL OR ((bag_index_q64_bits = '0' OR (bag_index_q64_bits ~ '^[1-9][0-9]*$')) AND (length(bag_index_q64_bits), bag_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_index_q64_bits text COLLATE "C" NOT NULL CHECK(stake_index_q64_bits IS NULL OR ((stake_index_q64_bits = '0' OR (stake_index_q64_bits ~ '^[1-9][0-9]*$')) AND (length(stake_index_q64_bits), stake_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  CHECK (
    (index_status = 'published' AND index_completed_block IS NOT NULL AND (length(index_completed_block), index_completed_block) <= (length(finalized_block), finalized_block))
    OR (index_status = 'not_published' AND index_completed_block IS NULL
      AND bag_index_q64_bits = '18446744073709551616' AND stake_index_q64_bits = '18446744073709551616')
  ),
  UNIQUE (network_genesis_hash, finalized_block_hash, decoder_version)
);

CREATE TABLE app.root_basket_capture_pages (
  capture_id text COLLATE "C" NOT NULL CHECK(length(capture_id) = 36),
  page_index bigint NOT NULL CHECK(page_index BETWEEN 0 AND 4294967295),
  start_after text COLLATE "C" CHECK(start_after IS NULL OR (length(start_after) = 66 AND substr(start_after,1,2) = '0x' AND substr(start_after,3) !~ '[^0-9a-f]')),
  next_after text COLLATE "C" CHECK(next_after IS NULL OR (length(next_after) = 66 AND substr(next_after,1,2) = '0x' AND substr(next_after,3) !~ '[^0-9a-f]')),
  response_sha256 text COLLATE "C" NOT NULL CHECK(response_sha256 IS NULL OR (length(response_sha256) = 66 AND substr(response_sha256,1,2) = '0x' AND substr(response_sha256,3) !~ '[^0-9a-f]')),
  fund_count bigint NOT NULL CHECK (fund_count <= 256) CHECK(fund_count BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, page_index),
  CHECK ((page_index = 0) = (start_after IS NULL)),
  CHECK (start_after IS NULL OR next_after IS NULL OR start_after <> next_after)
);

CREATE TABLE app.root_basket_fund_snapshots (
  capture_id text COLLATE "C" NOT NULL CHECK(length(capture_id) = 36),
  hotkey text COLLATE "C" NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) !~ '[^0-9a-f]')),
  page_index bigint NOT NULL CHECK(page_index BETWEEN 0 AND 4294967295),
  shares_atomic text COLLATE "C" NOT NULL CHECK (shares_atomic <> '0') CHECK(shares_atomic IS NULL OR ((shares_atomic = '0' OR (shares_atomic ~ '^[1-9][0-9]*$')) AND (length(shares_atomic), shares_atomic) <= (20, '18446744073709551615'))),
  spot_nav_rao text COLLATE "C" NOT NULL CHECK(spot_nav_rao IS NULL OR ((spot_nav_rao = '0' OR (spot_nav_rao ~ '^[1-9][0-9]*$')) AND (length(spot_nav_rao), spot_nav_rao) <= (20, '18446744073709551615'))),
  realizable_nav_rao text COLLATE "C" NOT NULL CHECK(realizable_nav_rao IS NULL OR ((realizable_nav_rao = '0' OR (realizable_nav_rao ~ '^[1-9][0-9]*$')) AND (length(realizable_nav_rao), realizable_nav_rao) <= (20, '18446744073709551615'))),
  deposited_rao text COLLATE "C" NOT NULL CHECK(deposited_rao IS NULL OR ((deposited_rao = '0' OR (deposited_rao ~ '^[1-9][0-9]*$')) AND (length(deposited_rao), deposited_rao) <= (20, '18446744073709551615'))),
  redeemed_rao text COLLATE "C" NOT NULL CHECK(redeemed_rao IS NULL OR ((redeemed_rao = '0' OR (redeemed_rao ~ '^[1-9][0-9]*$')) AND (length(redeemed_rao), redeemed_rao) <= (20, '18446744073709551615'))),
  raw_spot_price_q64_bits text COLLATE "C" NOT NULL CHECK(raw_spot_price_q64_bits IS NULL OR ((raw_spot_price_q64_bits = '0' OR (raw_spot_price_q64_bits ~ '^[1-9][0-9]*$')) AND (length(raw_spot_price_q64_bits), raw_spot_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_price_q64_bits text COLLATE "C" NOT NULL CHECK(display_price_q64_bits IS NULL OR ((display_price_q64_bits = '0' OR (display_price_q64_bits ~ '^[1-9][0-9]*$')) AND (length(display_price_q64_bits), display_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_shares_q64_bits text COLLATE "C" NOT NULL CHECK(display_shares_q64_bits IS NULL OR ((display_shares_q64_bits = '0' OR (display_shares_q64_bits ~ '^[1-9][0-9]*$')) AND (length(display_shares_q64_bits), display_shares_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_price_q64_bits text COLLATE "C" NOT NULL CHECK(stake_price_q64_bits IS NULL OR ((stake_price_q64_bits = '0' OR (stake_price_q64_bits ~ '^[1-9][0-9]*$')) AND (length(stake_price_q64_bits), stake_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  staker_twr_q64_bits text COLLATE "C" NOT NULL CHECK(staker_twr_q64_bits IS NULL OR ((staker_twr_q64_bits = '0' OR (staker_twr_q64_bits ~ '^[1-9][0-9]*$')) AND (length(staker_twr_q64_bits), staker_twr_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  pending_entitlement_q64_bits text COLLATE "C" NOT NULL CHECK(pending_entitlement_q64_bits IS NULL OR ((pending_entitlement_q64_bits = '0' OR (pending_entitlement_q64_bits ~ '^[1-9][0-9]*$')) AND (length(pending_entitlement_q64_bits), pending_entitlement_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  provisional bigint NOT NULL CHECK(provisional IN (0,1)),
  first_block text COLLATE "C" NOT NULL CHECK(first_block IS NULL OR ((first_block = '0' OR (first_block ~ '^[1-9][0-9]*$')) AND (length(first_block), first_block) <= (20, '18446744073709551615'))),
  price_divisor_q64_bits text COLLATE "C" CHECK(price_divisor_q64_bits IS NULL OR ((price_divisor_q64_bits = '0' OR (price_divisor_q64_bits ~ '^[1-9][0-9]*$')) AND (length(price_divisor_q64_bits), price_divisor_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  rate0_q32_bits text COLLATE "C" CHECK(rate0_q32_bits IS NULL OR (CASE WHEN substr(rate0_q32_bits,1,1) = '-' THEN substr(rate0_q32_bits,2) <> '0' AND ((substr(rate0_q32_bits,2) = '0' OR (substr(rate0_q32_bits,2) ~ '^[1-9][0-9]*$')) AND (length(substr(rate0_q32_bits,2)), substr(rate0_q32_bits,2)) <= (39, '170141183460469231731687303715884105728')) ELSE (rate0_q32_bits = '0' OR (rate0_q32_bits ~ '^[1-9][0-9]*$')) AND (length(rate0_q32_bits), rate0_q32_bits) <= (39, '170141183460469231731687303715884105727') END)),
  tr_splice_q64_bits text COLLATE "C" CHECK(tr_splice_q64_bits IS NULL OR ((tr_splice_q64_bits = '0' OR (tr_splice_q64_bits ~ '^[1-9][0-9]*$')) AND (length(tr_splice_q64_bits), tr_splice_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  holdings_count bigint NOT NULL CHECK(holdings_count BETWEEN 0 AND 4294967295),
  targets_count bigint NOT NULL CHECK(targets_count BETWEEN 0 AND 4294967295),
  PRIMARY KEY (capture_id, hotkey),
  CHECK (
    (provisional = 1 AND first_block = '0' AND price_divisor_q64_bits IS NULL AND rate0_q32_bits IS NULL AND tr_splice_q64_bits IS NULL)
    OR (provisional = 0 AND first_block <> '0' AND price_divisor_q64_bits IS NOT NULL AND price_divisor_q64_bits <> '0'
      AND rate0_q32_bits IS NOT NULL AND tr_splice_q64_bits IS NOT NULL AND tr_splice_q64_bits <> '0')
  )
);

CREATE TABLE app.root_basket_holdings (
  capture_id text COLLATE "C" NOT NULL CHECK(length(capture_id) = 36),
  hotkey text COLLATE "C" NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) !~ '[^0-9a-f]')),
  netuid bigint NOT NULL CHECK(netuid BETWEEN 0 AND 65535),
  quantity_atomic text COLLATE "C" NOT NULL CHECK(quantity_atomic IS NULL OR ((quantity_atomic = '0' OR (quantity_atomic ~ '^[1-9][0-9]*$')) AND (length(quantity_atomic), quantity_atomic) <= (20, '18446744073709551615'))),
  quantity_unit text COLLATE "C" NOT NULL,
  spot_value_rao text COLLATE "C" NOT NULL CHECK(spot_value_rao IS NULL OR ((spot_value_rao = '0' OR (spot_value_rao ~ '^[1-9][0-9]*$')) AND (length(spot_value_rao), spot_value_rao) <= (20, '18446744073709551615'))),
  realizable_value_rao text COLLATE "C" NOT NULL CHECK(realizable_value_rao IS NULL OR ((realizable_value_rao = '0' OR (realizable_value_rao ~ '^[1-9][0-9]*$')) AND (length(realizable_value_rao), realizable_value_rao) <= (20, '18446744073709551615'))),
  PRIMARY KEY (capture_id, hotkey, netuid),
  CHECK ((netuid = 0 AND quantity_unit = 'rao') OR (netuid > 0 AND quantity_unit = 'alpha_atomic'))
);

CREATE TABLE app.root_basket_targets (
  capture_id text COLLATE "C" NOT NULL CHECK(length(capture_id) = 36),
  hotkey text COLLATE "C" NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) !~ '[^0-9a-f]')),
  netuid bigint NOT NULL CHECK(netuid BETWEEN 0 AND 65535),
  weight bigint NOT NULL CHECK(weight BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, hotkey, netuid)
);

CREATE TABLE app.root_basket_capture_completions (
  capture_id text COLLATE "C" NOT NULL PRIMARY KEY CHECK(length(capture_id) = 36),
  content_sha256 text COLLATE "C" NOT NULL CHECK(content_sha256 IS NULL OR (length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) !~ '[^0-9a-f]')),
  accepted_at_ms text COLLATE "C" NOT NULL CHECK(accepted_at_ms IS NULL OR ((accepted_at_ms = '0' OR (accepted_at_ms ~ '^[1-9][0-9]*$')) AND (length(accepted_at_ms), accepted_at_ms) <= (20, '18446744073709551615')))
);

CREATE TABLE app.root_basket_current (
  network_genesis_hash text COLLATE "C" NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) !~ '[^0-9a-f]')),
  decoder_version text COLLATE "C" NOT NULL,
  capture_id text COLLATE "C" NOT NULL CHECK(length(capture_id) = 36),
  PRIMARY KEY (network_genesis_hash, decoder_version)
);

CREATE UNIQUE INDEX root_basket_capture_page_cursors ON app.root_basket_capture_pages (capture_id,coalesce(start_after,''));

CREATE UNIQUE INDEX root_basket_capture_terminal_page ON app.root_basket_capture_pages (capture_id) WHERE next_after IS NULL;

CREATE INDEX root_basket_captures_export ON app.root_basket_captures
  (network, network_genesis_hash, decoder_version, capture_id);

CREATE INDEX root_basket_captures_history ON app.root_basket_captures (network_genesis_hash, length(finalized_block) DESC, finalized_block DESC);

CREATE INDEX root_basket_fund_address_history ON app.root_basket_fund_snapshots (hotkey,capture_id);
