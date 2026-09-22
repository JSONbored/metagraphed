-- Native finalized capture receipts (#12183). Wide integers remain canonical
-- decimal TEXT; comparisons use digit count then lexical order, never REAL.
CREATE TABLE root_basket_captures (
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) NOT GLOB '*[^0-9a-f]*'),
  capture_id TEXT NOT NULL PRIMARY KEY CHECK(length(capture_id) = 36),
  network TEXT NOT NULL CHECK (network IN ('finney', 'test', 'local')),
  network_genesis_hash TEXT  NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) NOT GLOB '*[^0-9a-f]*')),
  finalized_block_hash TEXT  NOT NULL CHECK(finalized_block_hash IS NULL OR (length(finalized_block_hash) = 66 AND substr(finalized_block_hash,1,2) = '0x' AND substr(finalized_block_hash,3) NOT GLOB '*[^0-9a-f]*')),
  finalized_block TEXT  NOT NULL CHECK(finalized_block IS NULL OR (typeof(finalized_block) = 'text' AND (finalized_block = '0' OR (finalized_block GLOB '[1-9]*' AND finalized_block NOT GLOB '*[^0-9]*')) AND (length(finalized_block), finalized_block) <= (20, '18446744073709551615'))),
  runtime_spec_version INTEGER  NOT NULL CHECK (runtime_spec_version = 454) CHECK(typeof(runtime_spec_version) = 'integer' AND runtime_spec_version BETWEEN 0 AND 4294967295),
  runtime_api_version INTEGER  NOT NULL CHECK (runtime_api_version = 3) CHECK(typeof(runtime_api_version) = 'integer' AND runtime_api_version BETWEEN 0 AND 65535),
  decoder_version TEXT NOT NULL CHECK (decoder_version = 'subtensor-v454-14cde641-v1'),
  metadata_sha256 TEXT  NOT NULL CHECK(metadata_sha256 IS NULL OR (length(metadata_sha256) = 66 AND substr(metadata_sha256,1,2) = '0x' AND substr(metadata_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  started_at_ms TEXT  NOT NULL CHECK(started_at_ms IS NULL OR (typeof(started_at_ms) = 'text' AND (started_at_ms = '0' OR (started_at_ms GLOB '[1-9]*' AND started_at_ms NOT GLOB '*[^0-9]*')) AND (length(started_at_ms), started_at_ms) <= (20, '18446744073709551615'))),
  finished_at_ms TEXT  NOT NULL CHECK ((length(finished_at_ms), finished_at_ms) >= (length(started_at_ms), started_at_ms)) CHECK(finished_at_ms IS NULL OR (typeof(finished_at_ms) = 'text' AND (finished_at_ms = '0' OR (finished_at_ms GLOB '[1-9]*' AND finished_at_ms NOT GLOB '*[^0-9]*')) AND (length(finished_at_ms), finished_at_ms) <= (20, '18446744073709551615'))),
  expected_pages INTEGER  NOT NULL CHECK (expected_pages > 0) CHECK(typeof(expected_pages) = 'integer' AND expected_pages BETWEEN 0 AND 4294967295),
  expected_funds INTEGER  NOT NULL CHECK(typeof(expected_funds) = 'integer' AND expected_funds BETWEEN 0 AND 4294967295),
  index_status TEXT NOT NULL CHECK (index_status IN ('published', 'not_published')),
  index_completed_block TEXT  CHECK(index_completed_block IS NULL OR (typeof(index_completed_block) = 'text' AND (index_completed_block = '0' OR (index_completed_block GLOB '[1-9]*' AND index_completed_block NOT GLOB '*[^0-9]*')) AND (length(index_completed_block), index_completed_block) <= (20, '18446744073709551615'))),
  bag_index_q64_bits TEXT  NOT NULL CHECK(bag_index_q64_bits IS NULL OR (typeof(bag_index_q64_bits) = 'text' AND (bag_index_q64_bits = '0' OR (bag_index_q64_bits GLOB '[1-9]*' AND bag_index_q64_bits NOT GLOB '*[^0-9]*')) AND (length(bag_index_q64_bits), bag_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_index_q64_bits TEXT  NOT NULL CHECK(stake_index_q64_bits IS NULL OR (typeof(stake_index_q64_bits) = 'text' AND (stake_index_q64_bits = '0' OR (stake_index_q64_bits GLOB '[1-9]*' AND stake_index_q64_bits NOT GLOB '*[^0-9]*')) AND (length(stake_index_q64_bits), stake_index_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  CHECK (
    (index_status = 'published' AND index_completed_block IS NOT NULL AND (length(index_completed_block), index_completed_block) <= (length(finalized_block), finalized_block))
    OR (index_status = 'not_published' AND index_completed_block IS NULL
      AND bag_index_q64_bits = '18446744073709551616' AND stake_index_q64_bits = '18446744073709551616')
  ),
  UNIQUE (network_genesis_hash, finalized_block_hash, decoder_version)
);
-- statement-breakpoint
CREATE TABLE root_basket_capture_pages (
  capture_id TEXT  NOT NULL REFERENCES root_basket_captures (capture_id) CHECK(length(capture_id) = 36),
  page_index INTEGER  NOT NULL CHECK(typeof(page_index) = 'integer' AND page_index BETWEEN 0 AND 4294967295),
  start_after TEXT  CHECK(start_after IS NULL OR (length(start_after) = 66 AND substr(start_after,1,2) = '0x' AND substr(start_after,3) NOT GLOB '*[^0-9a-f]*')),
  next_after TEXT  CHECK(next_after IS NULL OR (length(next_after) = 66 AND substr(next_after,1,2) = '0x' AND substr(next_after,3) NOT GLOB '*[^0-9a-f]*')),
  response_sha256 TEXT  NOT NULL CHECK(response_sha256 IS NULL OR (length(response_sha256) = 66 AND substr(response_sha256,1,2) = '0x' AND substr(response_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  fund_count INTEGER  NOT NULL CHECK (fund_count <= 256) CHECK(typeof(fund_count) = 'integer' AND fund_count BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, page_index),
  CHECK ((page_index = 0) = (start_after IS NULL)),
  CHECK (start_after IS NULL OR next_after IS NULL OR start_after <> next_after)
);
-- statement-breakpoint
CREATE TABLE root_basket_fund_snapshots (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  page_index INTEGER  NOT NULL CHECK(typeof(page_index) = 'integer' AND page_index BETWEEN 0 AND 4294967295),
  shares_atomic TEXT  NOT NULL CHECK (shares_atomic <> '0') CHECK(shares_atomic IS NULL OR (typeof(shares_atomic) = 'text' AND (shares_atomic = '0' OR (shares_atomic GLOB '[1-9]*' AND shares_atomic NOT GLOB '*[^0-9]*')) AND (length(shares_atomic), shares_atomic) <= (20, '18446744073709551615'))),
  spot_nav_rao TEXT  NOT NULL CHECK(spot_nav_rao IS NULL OR (typeof(spot_nav_rao) = 'text' AND (spot_nav_rao = '0' OR (spot_nav_rao GLOB '[1-9]*' AND spot_nav_rao NOT GLOB '*[^0-9]*')) AND (length(spot_nav_rao), spot_nav_rao) <= (20, '18446744073709551615'))),
  realizable_nav_rao TEXT  NOT NULL CHECK(realizable_nav_rao IS NULL OR (typeof(realizable_nav_rao) = 'text' AND (realizable_nav_rao = '0' OR (realizable_nav_rao GLOB '[1-9]*' AND realizable_nav_rao NOT GLOB '*[^0-9]*')) AND (length(realizable_nav_rao), realizable_nav_rao) <= (20, '18446744073709551615'))),
  deposited_rao TEXT  NOT NULL CHECK(deposited_rao IS NULL OR (typeof(deposited_rao) = 'text' AND (deposited_rao = '0' OR (deposited_rao GLOB '[1-9]*' AND deposited_rao NOT GLOB '*[^0-9]*')) AND (length(deposited_rao), deposited_rao) <= (20, '18446744073709551615'))),
  redeemed_rao TEXT  NOT NULL CHECK(redeemed_rao IS NULL OR (typeof(redeemed_rao) = 'text' AND (redeemed_rao = '0' OR (redeemed_rao GLOB '[1-9]*' AND redeemed_rao NOT GLOB '*[^0-9]*')) AND (length(redeemed_rao), redeemed_rao) <= (20, '18446744073709551615'))),
  raw_spot_price_q64_bits TEXT  NOT NULL CHECK(raw_spot_price_q64_bits IS NULL OR (typeof(raw_spot_price_q64_bits) = 'text' AND (raw_spot_price_q64_bits = '0' OR (raw_spot_price_q64_bits GLOB '[1-9]*' AND raw_spot_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(raw_spot_price_q64_bits), raw_spot_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_price_q64_bits TEXT  NOT NULL CHECK(display_price_q64_bits IS NULL OR (typeof(display_price_q64_bits) = 'text' AND (display_price_q64_bits = '0' OR (display_price_q64_bits GLOB '[1-9]*' AND display_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(display_price_q64_bits), display_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  display_shares_q64_bits TEXT  NOT NULL CHECK(display_shares_q64_bits IS NULL OR (typeof(display_shares_q64_bits) = 'text' AND (display_shares_q64_bits = '0' OR (display_shares_q64_bits GLOB '[1-9]*' AND display_shares_q64_bits NOT GLOB '*[^0-9]*')) AND (length(display_shares_q64_bits), display_shares_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  stake_price_q64_bits TEXT  NOT NULL CHECK(stake_price_q64_bits IS NULL OR (typeof(stake_price_q64_bits) = 'text' AND (stake_price_q64_bits = '0' OR (stake_price_q64_bits GLOB '[1-9]*' AND stake_price_q64_bits NOT GLOB '*[^0-9]*')) AND (length(stake_price_q64_bits), stake_price_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  staker_twr_q64_bits TEXT  NOT NULL CHECK(staker_twr_q64_bits IS NULL OR (typeof(staker_twr_q64_bits) = 'text' AND (staker_twr_q64_bits = '0' OR (staker_twr_q64_bits GLOB '[1-9]*' AND staker_twr_q64_bits NOT GLOB '*[^0-9]*')) AND (length(staker_twr_q64_bits), staker_twr_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  pending_entitlement_q64_bits TEXT  NOT NULL CHECK(pending_entitlement_q64_bits IS NULL OR (typeof(pending_entitlement_q64_bits) = 'text' AND (pending_entitlement_q64_bits = '0' OR (pending_entitlement_q64_bits GLOB '[1-9]*' AND pending_entitlement_q64_bits NOT GLOB '*[^0-9]*')) AND (length(pending_entitlement_q64_bits), pending_entitlement_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  provisional INTEGER  NOT NULL CHECK(provisional IN (0,1)),
  first_block TEXT  NOT NULL CHECK(first_block IS NULL OR (typeof(first_block) = 'text' AND (first_block = '0' OR (first_block GLOB '[1-9]*' AND first_block NOT GLOB '*[^0-9]*')) AND (length(first_block), first_block) <= (20, '18446744073709551615'))),
  price_divisor_q64_bits TEXT  CHECK(price_divisor_q64_bits IS NULL OR (typeof(price_divisor_q64_bits) = 'text' AND (price_divisor_q64_bits = '0' OR (price_divisor_q64_bits GLOB '[1-9]*' AND price_divisor_q64_bits NOT GLOB '*[^0-9]*')) AND (length(price_divisor_q64_bits), price_divisor_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  rate0_q32_bits TEXT  CHECK(rate0_q32_bits IS NULL OR (CASE WHEN substr(rate0_q32_bits,1,1) = '-' THEN substr(rate0_q32_bits,2) <> '0' AND (typeof(substr(rate0_q32_bits,2)) = 'text' AND (substr(rate0_q32_bits,2) = '0' OR (substr(rate0_q32_bits,2) GLOB '[1-9]*' AND substr(rate0_q32_bits,2) NOT GLOB '*[^0-9]*')) AND (length(substr(rate0_q32_bits,2)), substr(rate0_q32_bits,2)) <= (39, '170141183460469231731687303715884105728')) ELSE typeof(rate0_q32_bits) = 'text' AND (rate0_q32_bits = '0' OR (rate0_q32_bits GLOB '[1-9]*' AND rate0_q32_bits NOT GLOB '*[^0-9]*')) AND (length(rate0_q32_bits), rate0_q32_bits) <= (39, '170141183460469231731687303715884105727') END)),
  tr_splice_q64_bits TEXT  CHECK(tr_splice_q64_bits IS NULL OR (typeof(tr_splice_q64_bits) = 'text' AND (tr_splice_q64_bits = '0' OR (tr_splice_q64_bits GLOB '[1-9]*' AND tr_splice_q64_bits NOT GLOB '*[^0-9]*')) AND (length(tr_splice_q64_bits), tr_splice_q64_bits) <= (39, '340282366920938463463374607431768211455'))),
  holdings_count INTEGER  NOT NULL CHECK(typeof(holdings_count) = 'integer' AND holdings_count BETWEEN 0 AND 4294967295),
  targets_count INTEGER  NOT NULL CHECK(typeof(targets_count) = 'integer' AND targets_count BETWEEN 0 AND 4294967295),
  PRIMARY KEY (capture_id, hotkey),
  FOREIGN KEY (capture_id, page_index) REFERENCES root_basket_capture_pages (capture_id, page_index),
  CHECK (
    (provisional = 1 AND first_block = '0' AND price_divisor_q64_bits IS NULL AND rate0_q32_bits IS NULL AND tr_splice_q64_bits IS NULL)
    OR (provisional = 0 AND first_block <> '0' AND price_divisor_q64_bits IS NOT NULL AND price_divisor_q64_bits <> '0'
      AND rate0_q32_bits IS NOT NULL AND tr_splice_q64_bits IS NOT NULL AND tr_splice_q64_bits <> '0')
  )
);
-- statement-breakpoint
CREATE TABLE root_basket_holdings (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  netuid INTEGER  NOT NULL CHECK(typeof(netuid) = 'integer' AND netuid BETWEEN 0 AND 65535),
  quantity_atomic TEXT  NOT NULL CHECK(quantity_atomic IS NULL OR (typeof(quantity_atomic) = 'text' AND (quantity_atomic = '0' OR (quantity_atomic GLOB '[1-9]*' AND quantity_atomic NOT GLOB '*[^0-9]*')) AND (length(quantity_atomic), quantity_atomic) <= (20, '18446744073709551615'))),
  quantity_unit TEXT NOT NULL,
  spot_value_rao TEXT  NOT NULL CHECK(spot_value_rao IS NULL OR (typeof(spot_value_rao) = 'text' AND (spot_value_rao = '0' OR (spot_value_rao GLOB '[1-9]*' AND spot_value_rao NOT GLOB '*[^0-9]*')) AND (length(spot_value_rao), spot_value_rao) <= (20, '18446744073709551615'))),
  realizable_value_rao TEXT  NOT NULL CHECK(realizable_value_rao IS NULL OR (typeof(realizable_value_rao) = 'text' AND (realizable_value_rao = '0' OR (realizable_value_rao GLOB '[1-9]*' AND realizable_value_rao NOT GLOB '*[^0-9]*')) AND (length(realizable_value_rao), realizable_value_rao) <= (20, '18446744073709551615'))),
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey),
  CHECK ((netuid = 0 AND quantity_unit = 'rao') OR (netuid > 0 AND quantity_unit = 'alpha_atomic'))
);
-- statement-breakpoint
CREATE TABLE root_basket_targets (
  capture_id TEXT  NOT NULL CHECK(length(capture_id) = 36),
  hotkey TEXT  NOT NULL CHECK(hotkey IS NULL OR (length(hotkey) = 66 AND substr(hotkey,1,2) = '0x' AND substr(hotkey,3) NOT GLOB '*[^0-9a-f]*')),
  netuid INTEGER  NOT NULL CHECK(typeof(netuid) = 'integer' AND netuid BETWEEN 0 AND 65535),
  weight INTEGER  NOT NULL CHECK(typeof(weight) = 'integer' AND weight BETWEEN 0 AND 65535),
  PRIMARY KEY (capture_id, hotkey, netuid),
  FOREIGN KEY (capture_id, hotkey) REFERENCES root_basket_fund_snapshots (capture_id, hotkey)
);
-- statement-breakpoint
CREATE TABLE root_basket_capture_completions (
  capture_id TEXT NOT NULL PRIMARY KEY REFERENCES root_basket_captures (capture_id) CHECK(length(capture_id) = 36),
  content_sha256 TEXT  NOT NULL CHECK(content_sha256 IS NULL OR (length(content_sha256) = 66 AND substr(content_sha256,1,2) = '0x' AND substr(content_sha256,3) NOT GLOB '*[^0-9a-f]*')),
  accepted_at_ms TEXT  NOT NULL CHECK(accepted_at_ms IS NULL OR (typeof(accepted_at_ms) = 'text' AND (accepted_at_ms = '0' OR (accepted_at_ms GLOB '[1-9]*' AND accepted_at_ms NOT GLOB '*[^0-9]*')) AND (length(accepted_at_ms), accepted_at_ms) <= (20, '18446744073709551615')))
);
-- statement-breakpoint
CREATE TABLE root_basket_current (
  network_genesis_hash TEXT  NOT NULL CHECK(network_genesis_hash IS NULL OR (length(network_genesis_hash) = 66 AND substr(network_genesis_hash,1,2) = '0x' AND substr(network_genesis_hash,3) NOT GLOB '*[^0-9a-f]*')),
  decoder_version TEXT NOT NULL,
  capture_id TEXT  NOT NULL REFERENCES root_basket_capture_completions (capture_id) CHECK(length(capture_id) = 36),
  PRIMARY KEY (network_genesis_hash, decoder_version)
);
-- statement-breakpoint
CREATE INDEX root_basket_captures_history ON root_basket_captures (network_genesis_hash, length(finalized_block) DESC, finalized_block DESC);
-- statement-breakpoint
CREATE INDEX root_basket_fund_address_history ON root_basket_fund_snapshots (hotkey,capture_id);
-- statement-breakpoint
CREATE UNIQUE INDEX root_basket_capture_page_cursors ON root_basket_capture_pages (capture_id,coalesce(start_after,''));
-- statement-breakpoint
CREATE UNIQUE INDEX root_basket_capture_terminal_page ON root_basket_capture_pages (capture_id) WHERE next_after IS NULL;
-- statement-breakpoint
CREATE TRIGGER root_basket_check_replay BEFORE INSERT ON root_basket_captures BEGIN
 SELECT CASE WHEN EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id
   AND (network_genesis_hash <> NEW.network_genesis_hash OR finalized_block_hash <> NEW.finalized_block_hash OR decoder_version <> NEW.decoder_version))
 THEN RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: attempt ID already belongs to another observation') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM root_basket_captures WHERE network_genesis_hash = NEW.network_genesis_hash
   AND decoder_version = NEW.decoder_version AND finalized_block = NEW.finalized_block AND finalized_block_hash <> NEW.finalized_block_hash)
 THEN RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: finalized height has a different hash') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM root_basket_captures c LEFT JOIN root_basket_capture_completions r ON r.capture_id = c.capture_id
   WHERE c.network_genesis_hash = NEW.network_genesis_hash AND c.finalized_block_hash = NEW.finalized_block_hash AND c.decoder_version = NEW.decoder_version
   AND (r.capture_id IS NULL OR r.content_sha256 <> NEW.content_sha256))
 THEN RAISE(ABORT,'ROOT_BASKET_CAPTURE_CONFLICT: observation is incomplete or content differs') END;
END;
-- statement-breakpoint
CREATE TRIGGER root_basket_check_completion BEFORE INSERT ON root_basket_capture_completions BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND content_sha256 = NEW.content_sha256)
 OR EXISTS (SELECT 1 FROM root_basket_captures m WHERE m.capture_id = NEW.capture_id AND (
   (SELECT count(*) FROM root_basket_capture_pages WHERE capture_id = m.capture_id) <> m.expected_pages
   OR (SELECT count(*) FROM root_basket_fund_snapshots WHERE capture_id = m.capture_id) <> m.expected_funds
   OR EXISTS (SELECT 1 FROM root_basket_capture_pages p LEFT JOIN root_basket_capture_pages previous ON previous.capture_id = p.capture_id AND previous.page_index = p.page_index - 1
     WHERE p.capture_id = m.capture_id AND (p.page_index >= m.expected_pages
       OR (p.page_index = m.expected_pages - 1) <> (p.next_after IS NULL)
       OR (p.page_index > 0 AND (previous.page_index IS NULL OR p.start_after IS NOT previous.next_after))
       OR p.fund_count <> (SELECT count(*) FROM root_basket_fund_snapshots f WHERE f.capture_id = m.capture_id AND f.page_index = p.page_index)))
   OR EXISTS (SELECT 1 FROM root_basket_fund_snapshots f WHERE f.capture_id = m.capture_id AND (
     (length(f.first_block), f.first_block) > (length(m.finalized_block), m.finalized_block)
     OR f.holdings_count <> (SELECT count(*) FROM root_basket_holdings h WHERE h.capture_id = m.capture_id AND h.hotkey = f.hotkey)
     OR f.targets_count <> (SELECT count(*) FROM root_basket_targets t WHERE t.capture_id = m.capture_id AND t.hotkey = f.hotkey)))))
 THEN RAISE(ABORT,'root basket persisted capture is incomplete') END;
END;
-- statement-breakpoint
CREATE TRIGGER root_basket_captures_immutable_update BEFORE UPDATE ON root_basket_captures
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_captures_immutable_delete BEFORE DELETE ON root_basket_captures
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_capture_pages_immutable_insert BEFORE INSERT ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_capture_pages_immutable_update BEFORE UPDATE ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_capture_pages_immutable_delete BEFORE DELETE ON root_basket_capture_pages
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_fund_snapshots_immutable_insert BEFORE INSERT ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_fund_snapshots_immutable_update BEFORE UPDATE ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_fund_snapshots_immutable_delete BEFORE DELETE ON root_basket_fund_snapshots
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_holdings_immutable_insert BEFORE INSERT ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_holdings_immutable_update BEFORE UPDATE ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_holdings_immutable_delete BEFORE DELETE ON root_basket_holdings
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_targets_immutable_insert BEFORE INSERT ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_targets_immutable_update BEFORE UPDATE ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id,NEW.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_targets_immutable_delete BEFORE DELETE ON root_basket_targets
 WHEN EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (OLD.capture_id))
 BEGIN SELECT RAISE(ABORT,'completed root basket observation is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_completion_immutable_update BEFORE UPDATE ON root_basket_capture_completions BEGIN SELECT RAISE(ABORT,'root basket completion is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_completion_immutable_delete BEFORE DELETE ON root_basket_capture_completions BEGIN SELECT RAISE(ABORT,'root basket completion is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_receipt_immutable BEFORE UPDATE ON root_basket_capture_pages BEGIN SELECT RAISE(ABORT,'root basket receipt is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER root_basket_current_ordered_insert BEFORE INSERT ON root_basket_current BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND network_genesis_hash = NEW.network_genesis_hash AND decoder_version = NEW.decoder_version)
 THEN RAISE(ABORT,'root basket current scope mismatch') END;
END;
-- statement-breakpoint
CREATE TRIGGER root_basket_current_ordered_update BEFORE UPDATE ON root_basket_current BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM root_basket_captures WHERE capture_id = NEW.capture_id AND network_genesis_hash = NEW.network_genesis_hash AND decoder_version = NEW.decoder_version)
 THEN RAISE(ABORT,'root basket current scope mismatch') END;
 SELECT CASE WHEN NEW.network_genesis_hash <> OLD.network_genesis_hash OR NEW.decoder_version <> OLD.decoder_version
  OR (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = NEW.capture_id)
   < (SELECT length(finalized_block),finalized_block FROM root_basket_captures WHERE capture_id = OLD.capture_id)
  OR (NEW.capture_id <> OLD.capture_id AND (SELECT finalized_block FROM root_basket_captures WHERE capture_id = NEW.capture_id) = (SELECT finalized_block FROM root_basket_captures WHERE capture_id = OLD.capture_id))
 THEN RAISE(ABORT,'root basket current source order cannot regress') END;
END;
