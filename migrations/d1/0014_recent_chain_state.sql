-- Recent headers and atomic chain detail, including the coverage register (#12178).
CREATE TABLE blocks_head(
 block_number INTEGER NOT NULL,
 block_hash TEXT NOT NULL,
 parent_hash TEXT,
 extrinsic_count INTEGER,
 event_count INTEGER,
 author TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_blocks_head_hash_lower ON blocks_head (lower(block_hash));
-- statement-breakpoint
CREATE INDEX idx_blocks_head_observed ON blocks_head (observed_at DESC);
-- statement-breakpoint
CREATE TABLE chain_detail_blocks(
 block_number INTEGER NOT NULL,
 block_hash TEXT NOT NULL,
 spec_version INTEGER,
 extrinsic_count INTEGER NOT NULL,
 chain_event_count INTEGER NOT NULL,
 account_event_count INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 synced_at INTEGER NOT NULL,
 native_transfer_tao TEXT,
 stake_flow_tao TEXT,
 economic_activity_tao TEXT,
 fee_tao TEXT,
 tip_tao TEXT,
 issuance_tao TEXT,
 subnet_ids TEXT NOT NULL DEFAULT '[]',
 economics_complete INTEGER NOT NULL DEFAULT 0 CHECK(economics_complete IN(0,1)),
 PRIMARY KEY (block_number)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_chain_detail_blocks_hash ON chain_detail_blocks (block_hash);
-- statement-breakpoint
CREATE TABLE chain_detail_extrinsics(
 block_number INTEGER NOT NULL,
 extrinsic_index INTEGER NOT NULL,
 extrinsic_hash TEXT,
 signer TEXT,
 call_module TEXT,
 call_function TEXT,
 success INTEGER CHECK(success IN(0,1)),
 fee_tao TEXT,
 tip_tao TEXT,
 call_args TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, extrinsic_index)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_chain_detail_extrinsics_hash_lower ON chain_detail_extrinsics (lower(extrinsic_hash));
-- statement-breakpoint
CREATE INDEX idx_chain_detail_extrinsics_observed ON chain_detail_extrinsics (observed_at);
-- statement-breakpoint
CREATE TABLE chain_detail_account_events(
 block_number INTEGER NOT NULL,
 event_index INTEGER NOT NULL,
 extrinsic_index INTEGER,
 event_kind TEXT NOT NULL,
 hotkey TEXT,
 coldkey TEXT,
 netuid INTEGER,
 uid INTEGER,
 amount_tao TEXT,
 alpha_amount TEXT,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, event_index)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_chain_detail_account_events_coldkey_observed ON chain_detail_account_events (coldkey, observed_at DESC);
-- statement-breakpoint
CREATE INDEX idx_chain_detail_account_events_extrinsic ON chain_detail_account_events (block_number, extrinsic_index);
-- statement-breakpoint
CREATE INDEX idx_chain_detail_account_events_hotkey_observed ON chain_detail_account_events (hotkey, observed_at DESC);
-- statement-breakpoint
CREATE INDEX idx_chain_detail_account_events_observed ON chain_detail_account_events (observed_at);
-- statement-breakpoint
CREATE TABLE chain_detail_chain_events(
 block_number INTEGER NOT NULL,
 event_index INTEGER NOT NULL,
 pallet TEXT NOT NULL,
 method TEXT NOT NULL,
 args TEXT,
 phase TEXT NOT NULL,
 extrinsic_index INTEGER,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY (block_number, event_index)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_chain_detail_chain_events_extrinsic ON chain_detail_chain_events (block_number, extrinsic_index);
-- statement-breakpoint
CREATE INDEX idx_chain_detail_chain_events_observed ON chain_detail_chain_events (observed_at);
