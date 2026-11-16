-- Load phase for head/detail rows, dead-letter custody and the Iceberg catalog.
-- Source payloads remain text. Source 0/1 flags use the boolean01 codec.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.blocks_head (
    block_number bigint PRIMARY KEY,
    block_hash text COLLATE "C" NOT NULL,
    parent_hash text,
    extrinsic_count bigint,
    event_count bigint,
    author text,
    observed_at bigint NOT NULL
);
CREATE TABLE app.chain_detail_blocks (
    block_number bigint PRIMARY KEY,
    block_hash text COLLATE "C" NOT NULL,
    spec_version bigint,
    extrinsic_count bigint NOT NULL,
    chain_event_count bigint NOT NULL,
    account_event_count bigint NOT NULL,
    observed_at bigint NOT NULL,
    synced_at bigint NOT NULL,
    native_transfer_tao text,
    stake_flow_tao text,
    economic_activity_tao text,
    fee_tao text,
    tip_tao text,
    issuance_tao text,
    subnet_ids text NOT NULL DEFAULT '[]',
    economics_complete boolean NOT NULL DEFAULT false
);
CREATE TABLE app.chain_detail_account_events (
    block_number bigint NOT NULL,
    event_index bigint NOT NULL,
    extrinsic_index bigint,
    event_kind text COLLATE "C" NOT NULL,
    hotkey text COLLATE "C",
    coldkey text COLLATE "C",
    netuid bigint,
    uid bigint,
    amount_tao text,
    alpha_amount text,
    observed_at bigint NOT NULL,
    PRIMARY KEY (block_number, event_index)
);
CREATE TABLE app.chain_detail_chain_events (
    block_number bigint NOT NULL,
    event_index bigint NOT NULL,
    pallet text NOT NULL,
    method text NOT NULL,
    args text,
    phase text NOT NULL,
    extrinsic_index bigint,
    observed_at bigint NOT NULL,
    PRIMARY KEY (block_number, event_index)
);
CREATE TABLE app.chain_detail_extrinsics (
    block_number bigint NOT NULL,
    extrinsic_index bigint NOT NULL,
    extrinsic_hash text COLLATE "C",
    signer text COLLATE "C",
    call_module text COLLATE "C",
    call_function text,
    success boolean,
    fee_tao text,
    tip_tao text,
    call_args text,
    observed_at bigint NOT NULL,
    PRIMARY KEY (block_number, extrinsic_index)
);
CREATE TABLE app.chain_detail_payload_chunks (
    sha256 text COLLATE "C" NOT NULL CHECK (length(sha256) = 64),
    part bigint NOT NULL CHECK (part >= 0 AND part < 12),
    data text NOT NULL CHECK (length(data) <= 1986668),
    PRIMARY KEY (sha256, part)
);
CREATE TABLE app.sync_dead_letters (
    message_id text COLLATE "C" PRIMARY KEY CHECK (length(message_id) BETWEEN 1 AND 256),
    body_sha256 text NOT NULL CHECK (length(body_sha256) = 64),
    encoding text NOT NULL CHECK (encoding IN ('json', 'base64')),
    payload text NOT NULL CHECK (octet_length(payload) <= 174764),
    received_at bigint NOT NULL
);
CREATE TABLE app.iceberg_catalog_namespaces (
    namespace text COLLATE "C" PRIMARY KEY,
    properties text NOT NULL CHECK (properties::json IS NOT NULL)
);
CREATE TABLE app.iceberg_catalog_tables (
    namespace text COLLATE "C" NOT NULL,
    name text COLLATE "C" NOT NULL,
    metadata_location text NOT NULL,
    previous_metadata_location text,
    metadata_summary text NOT NULL CHECK (metadata_summary::json IS NOT NULL),
    PRIMARY KEY (namespace, name)
);

CREATE INDEX idx_blocks_head_hash_lower ON app.blocks_head (lower(block_hash));
CREATE INDEX idx_blocks_head_observed ON app.blocks_head (observed_at DESC);
CREATE INDEX idx_chain_detail_blocks_hash ON app.chain_detail_blocks (block_hash);
CREATE INDEX idx_chain_detail_blocks_hash_lower ON app.chain_detail_blocks (lower(block_hash));
CREATE INDEX idx_chain_detail_account_events_coldkey_observed ON app.chain_detail_account_events (coldkey, observed_at DESC);
CREATE INDEX idx_chain_detail_account_events_extrinsic ON app.chain_detail_account_events (block_number, extrinsic_index);
CREATE INDEX idx_chain_detail_account_events_hotkey_observed ON app.chain_detail_account_events (hotkey, observed_at DESC);
CREATE INDEX idx_chain_detail_account_events_netuid_block ON app.chain_detail_account_events (netuid, block_number, event_kind);
CREATE INDEX idx_chain_detail_account_events_observed ON app.chain_detail_account_events (observed_at);
CREATE INDEX idx_chain_detail_chain_events_extrinsic ON app.chain_detail_chain_events (block_number, extrinsic_index);
CREATE INDEX idx_chain_detail_chain_events_observed ON app.chain_detail_chain_events (observed_at);
CREATE INDEX idx_chain_detail_extrinsics_hash_lower ON app.chain_detail_extrinsics (lower(extrinsic_hash));
CREATE INDEX idx_chain_detail_extrinsics_module_observed ON app.chain_detail_extrinsics (call_module, observed_at DESC, block_number DESC, extrinsic_index DESC);
CREATE INDEX idx_chain_detail_extrinsics_observed ON app.chain_detail_extrinsics (observed_at);
CREATE INDEX idx_chain_detail_extrinsics_signer_feed ON app.chain_detail_extrinsics (signer, observed_at DESC, block_number DESC, extrinsic_index DESC) WHERE signer IS NOT NULL;
CREATE INDEX sync_dead_letters_received_idx ON app.sync_dead_letters (received_at);
