-- Bounded metric documents and stable relational indexes (#12167).
CREATE TABLE neurons_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE neurons_members (netuid INTEGER NOT NULL,uid INTEGER NOT NULL,hotkey TEXT,coldkey TEXT,shard INTEGER NOT NULL,PRIMARY KEY(netuid,uid)) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX neurons_members_hotkey_idx ON neurons_members(hotkey);
-- statement-breakpoint
CREATE INDEX neurons_members_coldkey_idx ON neurons_members(coldkey);
-- statement-breakpoint
CREATE VIEW neurons AS SELECT m.netuid AS netuid,m.uid AS uid,m.hotkey AS hotkey,m.coldkey AS coldkey,json_extract(d.payload,'$."'||m.uid||'".active') AS active,json_extract(d.payload,'$."'||m.uid||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||m.uid||'".rank') AS rank,json_extract(d.payload,'$."'||m.uid||'".trust') AS trust,json_extract(d.payload,'$."'||m.uid||'".validator_trust') AS validator_trust,json_extract(d.payload,'$."'||m.uid||'".consensus') AS consensus,json_extract(d.payload,'$."'||m.uid||'".incentive') AS incentive,json_extract(d.payload,'$."'||m.uid||'".dividends') AS dividends,json_extract(d.payload,'$."'||m.uid||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||m.uid||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||m.uid||'".registered_at_block') AS registered_at_block,json_extract(d.payload,'$."'||m.uid||'".is_immunity_period') AS is_immunity_period,json_extract(d.payload,'$."'||m.uid||'".axon') AS axon,json_extract(d.payload,'$."'||m.uid||'".block_number') AS block_number,json_extract(d.payload,'$."'||m.uid||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||m.uid||'".take') AS take FROM neurons_members m JOIN neurons_documents d ON d.netuid=m.netuid AND d.day='' AND d.shard=m.shard;
-- statement-breakpoint
CREATE TABLE neuron_daily_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE neuron_daily_members (netuid INTEGER NOT NULL,uid INTEGER NOT NULL,snapshot_date TEXT NOT NULL,hotkey TEXT,coldkey TEXT,shard INTEGER NOT NULL,PRIMARY KEY(netuid,uid,snapshot_date)) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX neuron_daily_members_hotkey_idx ON neuron_daily_members(hotkey);
-- statement-breakpoint
CREATE INDEX neuron_daily_members_coldkey_idx ON neuron_daily_members(coldkey);
-- statement-breakpoint
CREATE INDEX neuron_daily_members_snapshot_date_netuid_idx ON neuron_daily_members(snapshot_date,netuid);
-- statement-breakpoint
CREATE VIEW neuron_daily AS SELECT m.netuid AS netuid,m.uid AS uid,m.hotkey AS hotkey,m.coldkey AS coldkey,json_extract(d.payload,'$."'||m.uid||'".active') AS active,json_extract(d.payload,'$."'||m.uid||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||m.uid||'".rank') AS rank,json_extract(d.payload,'$."'||m.uid||'".trust') AS trust,json_extract(d.payload,'$."'||m.uid||'".validator_trust') AS validator_trust,json_extract(d.payload,'$."'||m.uid||'".consensus') AS consensus,json_extract(d.payload,'$."'||m.uid||'".incentive') AS incentive,json_extract(d.payload,'$."'||m.uid||'".dividends') AS dividends,json_extract(d.payload,'$."'||m.uid||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||m.uid||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||m.uid||'".registered_at_block') AS registered_at_block,json_extract(d.payload,'$."'||m.uid||'".is_immunity_period') AS is_immunity_period,json_extract(d.payload,'$."'||m.uid||'".axon') AS axon,json_extract(d.payload,'$."'||m.uid||'".block_number') AS block_number,json_extract(d.payload,'$."'||m.uid||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||m.uid||'".take') AS take,m.snapshot_date AS snapshot_date,json_extract(d.payload,'$."'||m.uid||'".updated_at') AS updated_at FROM neuron_daily_members m JOIN neuron_daily_documents d ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard;
-- statement-breakpoint
CREATE TABLE account_position_daily_documents (
 netuid INTEGER NOT NULL, day TEXT NOT NULL, shard INTEGER NOT NULL,
 stamp INTEGER NOT NULL CHECK(stamp >= 1000000000000),
 payload BLOB NOT NULL CHECK(length(payload) <= 524288 AND json_valid(payload,8)),
 PRIMARY KEY(netuid,day,shard)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE account_position_daily_members (account TEXT NOT NULL,netuid INTEGER NOT NULL,snapshot_date TEXT NOT NULL,shard INTEGER NOT NULL,PRIMARY KEY(account,netuid,snapshot_date)) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX account_position_daily_members_account_snapshot_date_idx ON account_position_daily_members(account,snapshot_date);
-- statement-breakpoint
CREATE INDEX account_position_daily_members_snapshot_date_netuid_idx ON account_position_daily_members(snapshot_date,netuid);
-- statement-breakpoint
CREATE VIEW account_position_daily AS SELECT m.account AS account,m.netuid AS netuid,m.snapshot_date AS snapshot_date,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".uid') AS uid,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".coldkey') AS coldkey,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".active') AS active,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".validator_permit') AS validator_permit,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".rank') AS rank,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".trust') AS trust,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".incentive') AS incentive,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".dividends') AS dividends,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".stake_tao') AS stake_tao,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".emission_tao') AS emission_tao,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".captured_at') AS captured_at,json_extract(d.payload,'$."'||('k'||hex(m.account))||'".updated_at') AS updated_at FROM account_position_daily_members m JOIN account_position_daily_documents d ON d.netuid=m.netuid AND d.day=m.snapshot_date AND d.shard=m.shard;
-- statement-breakpoint
CREATE TABLE neurons_passes(captured_at INTEGER PRIMARY KEY NOT NULL,expected_rows INTEGER NOT NULL,received_rows INTEGER NOT NULL DEFAULT 0,completed_at INTEGER);
-- statement-breakpoint
CREATE INDEX neurons_passes_completed_idx ON neurons_passes(completed_at DESC);
