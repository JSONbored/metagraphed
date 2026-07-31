-- Dormant TAO-flow emission path watch (#8750).
--
-- v440 ships a second, fully-written implementation of emission shares
-- (`get_shares_flow`, computing shares from TAO FLOW EMAs instead of price
-- EMAs). It is `#[allow(dead_code)]` and the live path is
-- `get_shares_price_ema`. If it is switched on, the gate's input changes from
-- price to demand flow and every published emission number moves at once --
-- and there is no governance pallet (#8697), so there is no proposal or vote
-- to see it coming.
--
-- The machinery is provisioned and partially warm: the raw accumulator
-- (`SubnetTaoFlow`) is written continuously by live stake/swap code, while
-- `SubnetEmaTaoFlow` is set on 124 of 128 subnets and every one of them is
-- frozen at exactly block 8,466,530. That is the signature of a code path that
-- ran and was switched off -- staged, not abandoned.
--
-- Append-on-change, same as emission_gate_param_history (0047): zero rows is
-- the correct steady state and means the price path is still live, NOT that
-- the monitor is broken.
--
-- `SubnetTaoFlow` (the raw accumulator) is deliberately NOT watched: it moves
-- continuously with ordinary staking and swapping and carries no signal about
-- the dormant path.
CREATE TABLE IF NOT EXISTS emission_flow_watch (
  id               BIGSERIAL PRIMARY KEY,
  -- 'net_tao_flow_enabled' | 'flow_norm_exponent' | 'tao_flow_cutoff'
  -- | 'flow_ema_smoothing_factor' | 'subnet_ema_tao_flow'
  item             TEXT     NOT NULL,
  -- NULL for the four network-level parameters; the subnet for EMA rows.
  netuid           INTEGER,
  -- For parameters: whether the storage item is now SET. All four are unset on
  -- chain today, so "became set" is the alertable event.
  is_set           BOOLEAN  NOT NULL,
  -- For EMA rows only: the block the entry is stamped at. A value above
  -- EMA_FROZEN_BASELINE_BLOCK means get_shares_flow has run -- the earliest
  -- and most reliable signal, since the EMA resumes whether or not
  -- NetTaoFlowEnabled was flipped.
  ema_block        BIGINT,
  block_number     BIGINT,
  observed_at      BIGINT   NOT NULL,
  -- TRUE only on an item's FIRST row: capture began with these already in
  -- whatever state they were in, and that state is not itself an event. Same
  -- reasoning as emission_gate_param_history's own column (0047).
  predates_capture BOOLEAN  NOT NULL DEFAULT FALSE,
  CONSTRAINT emission_flow_watch_item_check
    CHECK (item IN (
      'net_tao_flow_enabled', 'flow_norm_exponent', 'tao_flow_cutoff',
      'flow_ema_smoothing_factor', 'subnet_ema_tao_flow'
    )),
  -- A parameter row carries no netuid and no EMA block; an EMA row carries
  -- both. Enforced so a malformed writer cannot quietly produce rows that read
  -- as neither.
  CONSTRAINT emission_flow_watch_shape_check
    CHECK (
      (item = 'subnet_ema_tao_flow' AND netuid IS NOT NULL AND ema_block IS NOT NULL)
      OR (item <> 'subnet_ema_tao_flow' AND netuid IS NULL AND ema_block IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS emission_flow_watch_item_observed_idx
  ON emission_flow_watch (item, observed_at DESC);
