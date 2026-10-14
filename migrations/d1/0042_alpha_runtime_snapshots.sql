-- Preserve original share-pool evidence and exact position rao. Legacy rows
-- remain readable until an entire qualified snapshot publishes atomically.
ALTER TABLE nominator_positions ADD COLUMN alpha_rao TEXT;
-- statement-breakpoint
ALTER TABLE nominator_positions ADD COLUMN alpha_evidence TEXT;
-- statement-breakpoint
CREATE TABLE alpha_runtime_metadata (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=66),
  spec_version INTEGER NOT NULL CHECK(spec_version IN (454,478)),
  scale_hex TEXT NOT NULL CHECK(length(scale_hex) BETWEEN 12 AND 2097154)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER alpha_runtime_metadata_identity BEFORE UPDATE ON alpha_runtime_metadata
BEGIN SELECT RAISE(ABORT,'Alpha runtime metadata is immutable'); END;
-- statement-breakpoint
CREATE TABLE alpha_snapshot_passes (
  captured_at INTEGER PRIMARY KEY CHECK(captured_at>0),
  block_number INTEGER NOT NULL CHECK(block_number BETWEEN 0 AND 4294967295),
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
  completed_at INTEGER,
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  CHECK(completed_at IS NULL OR (received_rows=expected_rows AND received_chunks=expected_chunks))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX alpha_snapshot_selected ON alpha_snapshot_passes(block_number DESC,captured_at DESC) WHERE selected=1;
-- statement-breakpoint
CREATE TABLE alpha_snapshot_chunks (
  captured_at INTEGER NOT NULL REFERENCES alpha_snapshot_passes(captured_at),
  batch_index INTEGER NOT NULL CHECK(batch_index>=0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  row_count INTEGER NOT NULL CHECK(row_count BETWEEN 0 AND 2500),
  first_owner TEXT,
  last_owner TEXT,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  PRIMARY KEY(captured_at,batch_index),
  CHECK((row_count=0 AND first_owner IS NULL AND last_owner IS NULL) OR
    (row_count>0 AND first_owner IS NOT NULL AND last_owner>=first_owner))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE alpha_snapshot_rows (
  captured_at INTEGER NOT NULL REFERENCES alpha_snapshot_passes(captured_at),
  coldkey TEXT NOT NULL,
  hotkey TEXT NOT NULL,
  netuid INTEGER NOT NULL CHECK(netuid BETWEEN 1 AND 65535),
  share_fraction REAL,
  shares TEXT,
  alpha_rao TEXT NOT NULL CHECK(length(alpha_rao) BETWEEN 1 AND 20 AND alpha_rao NOT GLOB '*[^0-9]*'),
  alpha_evidence TEXT NOT NULL CHECK(json_valid(alpha_evidence)),
  PRIMARY KEY(captured_at,coldkey,hotkey,netuid)
) WITHOUT ROWID;
-- statement-breakpoint
-- An old producer must not silently replace qualified Alpha values. Self-stake
-- owns its separate domain and may not erase an existing qualified Alpha row.
CREATE TRIGGER alpha_legacy_insert_fence BEFORE INSERT ON nominator_positions
WHEN NEW.alpha_evidence IS NULL AND EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1)
 AND (NEW.source='alpha' OR EXISTS(SELECT 1 FROM nominator_positions p WHERE
   p.coldkey=NEW.coldkey AND p.hotkey=NEW.hotkey AND p.netuid=NEW.netuid AND p.alpha_evidence IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'Qualified Alpha snapshot requires its runtime evidence'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_legacy_update_fence BEFORE UPDATE ON nominator_positions
WHEN NEW.alpha_evidence IS NULL AND EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1)
 AND (NEW.source='alpha' OR OLD.alpha_evidence IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'Qualified Alpha snapshot requires its runtime evidence'); END;

-- statement-breakpoint
CREATE TABLE alpha_snapshot_pools (
  captured_at INTEGER NOT NULL REFERENCES alpha_snapshot_passes(captured_at),
  hotkey TEXT NOT NULL,
  netuid INTEGER NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY(captured_at,hotkey,netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_pool_identity BEFORE INSERT ON alpha_snapshot_rows
BEGIN
  INSERT INTO alpha_snapshot_pools(captured_at,hotkey,netuid,evidence)
  VALUES(NEW.captured_at,NEW.hotkey,NEW.netuid,json_array(
    json_extract(NEW.alpha_evidence,'$.denominator'),
    json_extract(NEW.alpha_evidence,'$.total_alpha_rao'),
    json_extract(NEW.alpha_evidence,'$.pool_epoch')))
  ON CONFLICT(captured_at,hotkey,netuid) DO NOTHING;
  SELECT CASE WHEN (SELECT evidence FROM alpha_snapshot_pools WHERE
    captured_at=NEW.captured_at AND hotkey=NEW.hotkey AND netuid=NEW.netuid)
    IS NOT json_array(json_extract(NEW.alpha_evidence,'$.denominator'),
      json_extract(NEW.alpha_evidence,'$.total_alpha_rao'),json_extract(NEW.alpha_evidence,'$.pool_epoch'))
    THEN RAISE(ABORT,'Alpha pool identity differs at the same snapshot') END;
END;
-- statement-breakpoint
ALTER TABLE self_stake_snapshot_chunks ADD COLUMN source_rows INTEGER NOT NULL DEFAULT 0 CHECK(source_rows>=0);
-- statement-breakpoint
ALTER TABLE self_stake_snapshot_chunks ADD COLUMN shadowed_rows INTEGER NOT NULL DEFAULT 0 CHECK(shadowed_rows>=0);
-- statement-breakpoint
ALTER TABLE self_stake_snapshot_chunks ADD COLUMN alpha_captured_at INTEGER;

-- statement-breakpoint
CREATE INDEX alpha_snapshot_pending ON alpha_snapshot_passes(captured_at) WHERE completed_at IS NULL;
