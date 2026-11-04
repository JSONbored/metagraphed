-- Load original document bytes and members before attaching projection effects.
-- axon_index has SQLite BLOB affinity but contains every scalar storage class;
-- its tagged representation is decoded by readSqliteValue, never by jsonb.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app._audit_neuron_docs_20260922 (
    netuid bigint PRIMARY KEY,
    payload bytea NOT NULL,
    stamp bigint NOT NULL
);
CREATE TABLE app._audit_neuron_members_20260922 (
    netuid bigint NOT NULL,
    uid bigint NOT NULL,
    hotkey text NOT NULL,
    coldkey text,
    PRIMARY KEY (netuid, uid)
);
CREATE TABLE app.neurons_documents (
    netuid bigint NOT NULL,
    day text COLLATE "C" NOT NULL,
    shard bigint NOT NULL,
    stamp bigint NOT NULL CHECK (stamp >= 1000000000000),
    payload bytea NOT NULL CHECK (octet_length(payload) <= 524288),
    PRIMARY KEY (netuid, day, shard)
);
CREATE TABLE app.neurons_members (
    netuid bigint NOT NULL,
    uid bigint NOT NULL,
    hotkey text,
    coldkey text,
    shard bigint NOT NULL,
    PRIMARY KEY (netuid, uid)
);
CREATE TABLE app.neuron_daily_documents (
    netuid bigint NOT NULL,
    day text COLLATE "C" NOT NULL,
    shard bigint NOT NULL,
    stamp bigint NOT NULL CHECK (stamp >= 1000000000000),
    payload bytea NOT NULL CHECK (octet_length(payload) <= 524288),
    PRIMARY KEY (netuid, day, shard)
);
CREATE TABLE app.neuron_daily_members (
    netuid bigint NOT NULL,
    uid bigint NOT NULL,
    snapshot_date text COLLATE "C" NOT NULL,
    hotkey text,
    coldkey text,
    shard bigint NOT NULL,
    axon_index json,
    axon_indexed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (netuid, uid, snapshot_date)
);
CREATE TABLE app.account_position_daily_documents (
    netuid bigint NOT NULL,
    day text COLLATE "C" NOT NULL,
    shard bigint NOT NULL,
    stamp bigint NOT NULL CHECK (stamp >= 1000000000000),
    payload bytea NOT NULL CHECK (octet_length(payload) <= 524288),
    PRIMARY KEY (netuid, day, shard)
);
CREATE TABLE app.account_position_daily_members (
    account text COLLATE "C" NOT NULL,
    netuid bigint NOT NULL,
    snapshot_date text COLLATE "C" NOT NULL,
    shard bigint NOT NULL,
    PRIMARY KEY (account, netuid, snapshot_date)
);
CREATE TABLE app.neurons_capture_batches (
    batch_id text COLLATE "C" PRIMARY KEY CHECK (length(batch_id) = 64),
    captured_at bigint NOT NULL,
    sha256 text NOT NULL CHECK (length(sha256) = 64),
    applied boolean NOT NULL DEFAULT false
);
CREATE TABLE app.neurons_passes (
    captured_at bigint PRIMARY KEY,
    expected_rows bigint NOT NULL,
    received_rows bigint NOT NULL DEFAULT 0,
    completed_at bigint
);

-- Derived by the pinned native decoder, never by PostgreSQL jsonb. Raw bytes
-- remain in the original source table; the receipt binds its exact content.
CREATE TABLE app.neuron_document_projections (
    source_table text COLLATE "C" NOT NULL CHECK (source_table IN (
        'neurons_documents', 'neuron_daily_documents',
        'account_position_daily_documents', '_audit_neuron_docs_20260922')),
    netuid bigint NOT NULL,
    day text COLLATE "C" NOT NULL,
    shard bigint NOT NULL,
    payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
    payload_json text NOT NULL,
    axon_values json NOT NULL CHECK (json_typeof(axon_values) = 'array'),
    decoder_version text NOT NULL CHECK (decoder_version = '3.54.1'),
    decoder_source_id text NOT NULL CHECK (decoder_source_id =
        '2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76'),
    CHECK (source_table <> '_audit_neuron_docs_20260922' OR (day = '' AND shard = 0)),
    PRIMARY KEY (source_table, netuid, day, shard)
);

CREATE INDEX _audit_neuron_coldkey_20260922 ON app._audit_neuron_members_20260922 (coldkey);
CREATE INDEX _audit_neuron_hotkey_20260922 ON app._audit_neuron_members_20260922 (hotkey);
CREATE INDEX account_position_daily_documents_day_idx ON app.account_position_daily_documents (day, netuid, shard);
CREATE INDEX account_position_daily_members_account_snapshot_date_idx ON app.account_position_daily_members (account, snapshot_date);
CREATE INDEX account_position_daily_members_date_shard_idx ON app.account_position_daily_members (snapshot_date, netuid, shard);
CREATE INDEX idx_neurons_capture_batches_capture ON app.neurons_capture_batches (captured_at, batch_id);
CREATE INDEX neuron_daily_axon_pending_idx ON app.neuron_daily_members (netuid, uid, snapshot_date) WHERE NOT axon_indexed;
CREATE INDEX neuron_daily_documents_day_idx ON app.neuron_daily_documents (day, netuid, shard);
CREATE INDEX neuron_daily_members_coldkey_idx ON app.neuron_daily_members (coldkey);
CREATE INDEX neuron_daily_members_date_shard_idx ON app.neuron_daily_members (snapshot_date, netuid, shard);
CREATE INDEX neuron_daily_members_hotkey_idx ON app.neuron_daily_members (hotkey);
CREATE INDEX neuron_daily_members_subnet_day_shard_idx ON app.neuron_daily_members (netuid, snapshot_date DESC, shard, uid, hotkey, coldkey);
CREATE INDEX neurons_members_coldkey_idx ON app.neurons_members (coldkey);
CREATE INDEX neurons_members_hotkey_idx ON app.neurons_members (hotkey);
CREATE INDEX neurons_passes_completed_idx ON app.neurons_passes (completed_at DESC NULLS LAST);
