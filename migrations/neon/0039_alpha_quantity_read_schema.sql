-- Read-side schema parity for the runtime-qualified quantity family.
-- This does not select a PostgreSQL owner or implement ingestion/cutover.
-- Populate only from a coherent, independently qualified restore/shadow import;
-- migration application and writer ownership remain separately held.
ALTER TABLE nominator_positions
  ADD COLUMN IF NOT EXISTS alpha_rao TEXT,
  ADD COLUMN IF NOT EXISTS alpha_evidence TEXT;

CREATE TABLE IF NOT EXISTS alpha_runtime_metadata (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=66),
  spec_version INTEGER NOT NULL CHECK(spec_version IN (454,478)),
  scale_hex TEXT NOT NULL CHECK(length(scale_hex) BETWEEN 12 AND 2097154)
);

CREATE TABLE IF NOT EXISTS alpha_snapshot_passes (
  captured_at BIGINT PRIMARY KEY CHECK(captured_at>0),
  block_number BIGINT NOT NULL CHECK(block_number BETWEEN 0 AND 4294967295),
  block_hash TEXT NOT NULL CHECK(length(block_hash)=66),
  genesis_hash TEXT NOT NULL CHECK(length(genesis_hash)=66),
  spec_version INTEGER NOT NULL CHECK(spec_version IN (454,478)),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=66),
  metadata_sha256 TEXT NOT NULL REFERENCES alpha_runtime_metadata(sha256),
  scanned_legacy INTEGER NOT NULL CHECK(scanned_legacy>=0),
  scanned_v2 INTEGER NOT NULL CHECK(scanned_v2>=0),
  expected_rows INTEGER NOT NULL CHECK(expected_rows BETWEEN 0 AND 1000000),
  expected_chunks INTEGER NOT NULL CHECK(expected_chunks BETWEEN 1 AND 1000),
  received_rows INTEGER NOT NULL DEFAULT 0 CHECK(received_rows BETWEEN 0 AND expected_rows),
  received_chunks INTEGER NOT NULL DEFAULT 0 CHECK(received_chunks BETWEEN 0 AND expected_chunks),
  completed_at BIGINT,
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  CHECK(completed_at IS NULL OR (received_rows=expected_rows AND received_chunks=expected_chunks))
);
CREATE INDEX IF NOT EXISTS alpha_snapshot_selected
  ON alpha_snapshot_passes(block_number DESC,captured_at DESC) WHERE selected=1;
