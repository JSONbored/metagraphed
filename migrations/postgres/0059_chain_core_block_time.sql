-- The chain core's read views tell time by the block (ADR 0029 phase 1b; #13287).
--
-- 0058's views rendered `observed_at` from `chain.blocks.observed_at`, the
-- moment the producer read the block. For the live-follow lane that is the
-- block's own time give or take a few seconds, but a backfilled block is read
-- days or years after it was produced: its rows would sort above every live
-- one and fall outside every time filter that names when they happened. The
-- block's own time is its Timestamp.set inherent (`produced_at`), which every
-- finalized block carries, so the views read that and fall back to the
-- observation only where a block somehow has none. Columns, names and types
-- are unchanged, so every reader of 0058's shapes reads these.
CREATE OR REPLACE VIEW chain.block_rows AS
SELECT b.network_id, b.block_number, '0x' || encode(b.block_hash, 'hex') AS block_hash,
  b.spec_version, b.extrinsic_count, b.event_count AS chain_event_count, b.account_event_count,
  chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) AS observed_at, chain.epoch_ms(b.synced_at) AS synced_at,
  chain.tao_text(b.native_transfer_rao) AS native_transfer_tao,
  chain.tao_text(b.stake_flow_rao) AS stake_flow_tao,
  chain.tao_text(b.native_transfer_rao + b.stake_flow_rao) AS economic_activity_tao,
  chain.tao_text(b.fee_rao) AS fee_tao, chain.tao_text(b.tip_rao) AS tip_tao,
  chain.tao_text(b.issuance_rao) AS issuance_tao,
  array_to_json(b.subnet_ids)::text AS subnet_ids, b.economics_complete,
  chain.epoch_ms(b.produced_at) AS produced_at
FROM chain.blocks b;

CREATE OR REPLACE VIEW chain.extrinsic_rows AS
SELECT x.network_id, x.block_number, x.extrinsic_index,
  '0x' || encode(x.extrinsic_hash, 'hex') AS extrinsic_hash, a.ss58 AS signer,
  c.pallet AS call_module, c.name AS call_function, x.success,
  chain.tao_text(x.fee_rao) AS fee_tao, chain.tao_text(x.tip_rao) AS tip_tao,
  x.args::text AS call_args, chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) AS observed_at
FROM chain.extrinsics x
JOIN chain.blocks b ON b.network_id = x.network_id AND b.block_number = x.block_number
LEFT JOIN chain.accounts a ON a.account = x.signer
LEFT JOIN chain.calls c ON c.call = x.call;

CREATE OR REPLACE VIEW chain.chain_event_rows AS
SELECT e.network_id, e.block_number, e.event_index, k.pallet, k.name AS method,
  e.args::text AS args,
  CASE e.phase WHEN 0 THEN 'Initialization' WHEN 1 THEN 'ApplyExtrinsic' ELSE 'Finalization' END AS phase,
  e.extrinsic_index, chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) AS observed_at
FROM chain.events e
JOIN chain.blocks b ON b.network_id = e.network_id AND b.block_number = e.block_number
JOIN chain.event_kinds k ON k.kind = e.kind;

CREATE OR REPLACE VIEW chain.account_event_rows AS
SELECT e.network_id, e.block_number, e.event_index, e.extrinsic_index, k.name AS event_kind,
  h.ss58 AS hotkey, c.ss58 AS coldkey, e.netuid, e.uid,
  chain.tao_text(e.amount_rao) AS amount_tao, chain.tao_text(e.alpha_rao) AS alpha_amount,
  chain.epoch_ms(COALESCE(b.produced_at, b.observed_at)) AS observed_at,
  e.coldkey AS coldkey_account, e.hotkey AS hotkey_account
FROM chain.account_events e
JOIN chain.blocks b ON b.network_id = e.network_id AND b.block_number = e.block_number
JOIN chain.event_kinds k ON k.kind = e.kind
LEFT JOIN chain.accounts h ON h.account = e.hotkey
LEFT JOIN chain.accounts c ON c.account = e.coldkey;
