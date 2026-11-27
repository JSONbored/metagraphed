-- The chain core's reads (ADR 0029, phase 1b; #13287).
--
-- Block economics land typed beside the block (the sync parser computes them
-- from the batch), and four views project the typed tables into the row
-- shapes the API's formatters already read: the storage is the new model,
-- and the response contract does not move. Hashes render as 0x hex,
-- accounts as SS58, rao as exact decimal TAO, time as epoch milliseconds and
-- decoded arguments as their JSON text, which the formatters parse
-- preserving big integers.
ALTER TABLE chain.blocks
  ADD COLUMN account_event_count integer CHECK (account_event_count >= 0),
  ADD COLUMN native_transfer_rao bigint,
  ADD COLUMN stake_flow_rao bigint,
  ADD COLUMN issuance_rao bigint,
  ADD COLUMN subnet_ids integer[],
  ADD COLUMN economics_complete boolean,
  ADD COLUMN synced_at timestamptz;

-- Rao as the decoder writes TAO: whole units, then the fraction without
-- trailing zeros, and no point at all for a whole amount.
CREATE FUNCTION chain.tao_text(rao bigint) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE WHEN rao IS NULL THEN NULL ELSE
  CASE WHEN rao < 0 THEN '-' ELSE '' END
  || (abs(rao) / 1000000000)::text
  || COALESCE(NULLIF('.' || rtrim(lpad((abs(rao) % 1000000000)::text, 9, '0'), '0'), '.'), '')
END;

CREATE FUNCTION chain.epoch_ms(at timestamptz) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN (extract(epoch FROM at) * 1000)::bigint;

CREATE VIEW chain.block_rows AS
SELECT b.network_id, b.block_number, '0x' || encode(b.block_hash, 'hex') AS block_hash,
  b.spec_version, b.extrinsic_count, b.event_count AS chain_event_count, b.account_event_count,
  chain.epoch_ms(b.observed_at) AS observed_at, chain.epoch_ms(b.synced_at) AS synced_at,
  chain.tao_text(b.native_transfer_rao) AS native_transfer_tao,
  chain.tao_text(b.stake_flow_rao) AS stake_flow_tao,
  chain.tao_text(b.native_transfer_rao + b.stake_flow_rao) AS economic_activity_tao,
  chain.tao_text(b.fee_rao) AS fee_tao, chain.tao_text(b.tip_rao) AS tip_tao,
  chain.tao_text(b.issuance_rao) AS issuance_tao,
  array_to_json(b.subnet_ids)::text AS subnet_ids, b.economics_complete,
  chain.epoch_ms(b.produced_at) AS produced_at
FROM chain.blocks b;

CREATE VIEW chain.extrinsic_rows AS
SELECT x.network_id, x.block_number, x.extrinsic_index,
  '0x' || encode(x.extrinsic_hash, 'hex') AS extrinsic_hash, a.ss58 AS signer,
  c.pallet AS call_module, c.name AS call_function, x.success,
  chain.tao_text(x.fee_rao) AS fee_tao, chain.tao_text(x.tip_rao) AS tip_tao,
  x.args::text AS call_args, chain.epoch_ms(b.observed_at) AS observed_at
FROM chain.extrinsics x
JOIN chain.blocks b ON b.network_id = x.network_id AND b.block_number = x.block_number
LEFT JOIN chain.accounts a ON a.account = x.signer
LEFT JOIN chain.calls c ON c.call = x.call;

CREATE VIEW chain.chain_event_rows AS
SELECT e.network_id, e.block_number, e.event_index, k.pallet, k.name AS method,
  e.args::text AS args,
  CASE e.phase WHEN 0 THEN 'Initialization' WHEN 1 THEN 'ApplyExtrinsic' ELSE 'Finalization' END AS phase,
  e.extrinsic_index, chain.epoch_ms(b.observed_at) AS observed_at
FROM chain.events e
JOIN chain.blocks b ON b.network_id = e.network_id AND b.block_number = e.block_number
JOIN chain.event_kinds k ON k.kind = e.kind;

CREATE VIEW chain.account_event_rows AS
SELECT e.network_id, e.block_number, e.event_index, e.extrinsic_index, k.name AS event_kind,
  h.ss58 AS hotkey, c.ss58 AS coldkey, e.netuid, e.uid,
  chain.tao_text(e.amount_rao) AS amount_tao, chain.tao_text(e.alpha_rao) AS alpha_amount,
  chain.epoch_ms(b.observed_at) AS observed_at, e.coldkey AS coldkey_account, e.hotkey AS hotkey_account
FROM chain.account_events e
JOIN chain.blocks b ON b.network_id = e.network_id AND b.block_number = e.block_number
JOIN chain.event_kinds k ON k.kind = e.kind
LEFT JOIN chain.accounts h ON h.account = e.hotkey
LEFT JOIN chain.accounts c ON c.account = e.coldkey;
