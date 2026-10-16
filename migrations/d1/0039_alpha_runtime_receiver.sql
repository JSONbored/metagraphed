-- Additive incident receiver schema, based on the applied sequence through0038.
-- This focused migration replaces only the retained self-stake/Alpha proposals;
-- unrelated retention, raw-finality and webhook proposals are not prerequisites.
-- No values are backfilled, reinterpreted or selected by this DDL. Existing
-- unqualified originals retain NULL valuation when a later adapter qualifies.
-- A complete self-stake scan owns only its latest-only source domain. Keep
-- exact chunk receipts separate from the Alpha scan's completeness ledger.
ALTER TABLE validator_nominator_counts_passes ADD COLUMN alpha_snapshot TEXT
  CHECK(alpha_snapshot IS NULL OR json_valid(alpha_snapshot));
-- statement-breakpoint
CREATE TABLE self_stake_snapshot_passes (
    captured_at INTEGER PRIMARY KEY CHECK (captured_at > 0),
    scanned_pairs INTEGER NOT NULL CHECK (scanned_pairs > 0),
    expected_rows INTEGER NOT NULL CHECK (expected_rows >= 0 AND expected_rows <= scanned_pairs),
    expected_chunks INTEGER NOT NULL CHECK (expected_chunks > 0 AND expected_chunks <= 1000),
    received_rows INTEGER NOT NULL DEFAULT 0 CHECK (received_rows >= 0 AND received_rows <= expected_rows),
    received_chunks INTEGER NOT NULL DEFAULT 0 CHECK (received_chunks >= 0 AND received_chunks <= expected_chunks),
    completed_at INTEGER,
    CHECK (completed_at IS NULL OR (received_rows = expected_rows AND received_chunks = expected_chunks))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE self_stake_snapshot_chunks (
    captured_at INTEGER NOT NULL REFERENCES self_stake_snapshot_passes(captured_at),
    batch_index INTEGER NOT NULL CHECK (batch_index >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    row_count INTEGER NOT NULL CHECK (row_count >= 0 AND row_count <= 25000),
    first_owner TEXT,
    last_owner TEXT,
    applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0,1)),
    source_rows INTEGER NOT NULL DEFAULT 0 CHECK (source_rows >= 0),
    shadowed_rows INTEGER NOT NULL DEFAULT 0 CHECK (shadowed_rows >= 0),
    alpha_captured_at INTEGER,
    PRIMARY KEY (captured_at,batch_index),
    CHECK ((row_count = 0 AND first_owner IS NULL AND last_owner IS NULL) OR
           (row_count > 0 AND first_owner IS NOT NULL AND last_owner >= first_owner))
) WITHOUT ROWID;

-- statement-breakpoint
-- Preserve original share-pool evidence and nullable exact position rao. Legacy
-- rows remain until an entire structurally admitted snapshot publishes atomically.
ALTER TABLE nominator_positions ADD COLUMN alpha_rao TEXT;
-- statement-breakpoint
ALTER TABLE nominator_positions ADD COLUMN alpha_evidence TEXT;
-- statement-breakpoint
CREATE TABLE alpha_runtime_metadata (
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=66),
  spec_version INTEGER NOT NULL CHECK(spec_version IN (454,478,479)),
  scale_hex TEXT NOT NULL CHECK(length(scale_hex) BETWEEN 12 AND 2097154)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER alpha_runtime_metadata_identity BEFORE UPDATE ON alpha_runtime_metadata
WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.code_hash IS NOT OLD.code_hash
 OR NEW.spec_version IS NOT OLD.spec_version OR NEW.scale_hex IS NOT OLD.scale_hex
BEGIN SELECT RAISE(ABORT,'Alpha runtime metadata is immutable'); END;
-- statement-breakpoint
CREATE TABLE alpha_snapshot_passes (
  captured_at INTEGER PRIMARY KEY CHECK(captured_at>0),
  block_number INTEGER NOT NULL CHECK(block_number BETWEEN 0 AND 4294967295),
  block_hash TEXT NOT NULL CHECK(length(block_hash)=66),
  genesis_hash TEXT NOT NULL CHECK(length(genesis_hash)=66),
  spec_version INTEGER NOT NULL CHECK(spec_version IN (454,478,479)),
  code_hash TEXT NOT NULL CHECK(length(code_hash)=66),
  metadata_sha256 TEXT NOT NULL REFERENCES alpha_runtime_metadata(sha256),
  scanned_legacy INTEGER NOT NULL CHECK(scanned_legacy>=0),
  scanned_v2 INTEGER NOT NULL CHECK(scanned_v2>=0),
  distinct_members INTEGER NOT NULL CHECK(distinct_members BETWEEN 0 AND 2000000),
  excluded_root_members INTEGER NOT NULL CHECK(excluded_root_members BETWEEN 0 AND 2000000),
  expected_rows INTEGER NOT NULL CHECK(expected_rows BETWEEN 0 AND 1000000),
  expected_chunks INTEGER NOT NULL CHECK(expected_chunks BETWEEN 1 AND 1000),
  received_rows INTEGER NOT NULL DEFAULT 0 CHECK(received_rows BETWEEN 0 AND expected_rows),
  received_chunks INTEGER NOT NULL DEFAULT 0 CHECK(received_chunks BETWEEN 0 AND expected_chunks),
  completed_at INTEGER,
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  CHECK(distinct_members>=max(scanned_legacy,scanned_v2) AND distinct_members<=scanned_legacy+scanned_v2),
  CHECK(excluded_root_members<=distinct_members),
  CHECK(expected_rows=distinct_members-excluded_root_members),
  CHECK(spec_version<>479 OR (scanned_legacy=0 AND distinct_members=scanned_v2)),
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
  alpha_rao TEXT CHECK(length(alpha_rao) BETWEEN 1 AND 20 AND alpha_rao NOT GLOB '*[^0-9]*'),
  alpha_evidence TEXT NOT NULL CHECK(json_valid(alpha_evidence)),
  PRIMARY KEY(captured_at,coldkey,hotkey,netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX alpha_snapshot_count_members ON alpha_snapshot_rows(captured_at,hotkey,coldkey);
-- statement-breakpoint
CREATE INDEX alpha_count_capture ON validator_nominator_counts(captured_at,hotkey,nominator_count);
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
CREATE INDEX alpha_snapshot_pending ON alpha_snapshot_passes(captured_at) WHERE completed_at IS NULL;
-- statement-breakpoint
-- Metadata and evidence survive promotion. Replaying an identical statement is
-- harmless; changing or deleting an acknowledged original is refused.
CREATE TRIGGER alpha_runtime_metadata_preserve BEFORE DELETE ON alpha_runtime_metadata
BEGIN SELECT RAISE(ABORT,'Alpha runtime metadata is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_pass_identity BEFORE UPDATE ON alpha_snapshot_passes
WHEN NEW.captured_at IS NOT OLD.captured_at OR NEW.block_number IS NOT OLD.block_number
 OR NEW.block_hash IS NOT OLD.block_hash OR NEW.genesis_hash IS NOT OLD.genesis_hash
 OR NEW.spec_version IS NOT OLD.spec_version OR NEW.code_hash IS NOT OLD.code_hash
 OR NEW.metadata_sha256 IS NOT OLD.metadata_sha256 OR NEW.scanned_legacy IS NOT OLD.scanned_legacy
 OR NEW.scanned_v2 IS NOT OLD.scanned_v2 OR NEW.distinct_members IS NOT OLD.distinct_members
 OR NEW.excluded_root_members IS NOT OLD.excluded_root_members OR NEW.expected_rows IS NOT OLD.expected_rows
 OR NEW.expected_chunks IS NOT OLD.expected_chunks OR NEW.received_rows<OLD.received_rows
 OR NEW.received_chunks<OLD.received_chunks OR NEW.selected<OLD.selected
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)
BEGIN SELECT RAISE(ABORT,'Alpha snapshot identity is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_pass_preserve BEFORE DELETE ON alpha_snapshot_passes
BEGIN SELECT RAISE(ABORT,'Alpha snapshot identity is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_chunk_identity BEFORE UPDATE ON alpha_snapshot_chunks
WHEN NEW.captured_at IS NOT OLD.captured_at OR NEW.batch_index IS NOT OLD.batch_index
 OR NEW.sha256 IS NOT OLD.sha256 OR NEW.row_count IS NOT OLD.row_count
 OR NEW.first_owner IS NOT OLD.first_owner OR NEW.last_owner IS NOT OLD.last_owner
 OR NEW.applied<OLD.applied
BEGIN SELECT RAISE(ABORT,'Alpha chunk identity is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_chunk_preserve BEFORE DELETE ON alpha_snapshot_chunks
BEGIN SELECT RAISE(ABORT,'Alpha chunk receipt is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_row_identity BEFORE UPDATE ON alpha_snapshot_rows
WHEN NEW.captured_at IS NOT OLD.captured_at OR NEW.coldkey IS NOT OLD.coldkey
 OR NEW.hotkey IS NOT OLD.hotkey OR NEW.netuid IS NOT OLD.netuid
 OR NEW.share_fraction IS NOT OLD.share_fraction OR NEW.shares IS NOT OLD.shares
 OR NEW.alpha_rao IS NOT OLD.alpha_rao OR NEW.alpha_evidence IS NOT OLD.alpha_evidence
BEGIN SELECT RAISE(ABORT,'Alpha snapshot evidence is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_row_preserve BEFORE DELETE ON alpha_snapshot_rows
BEGIN SELECT RAISE(ABORT,'Alpha snapshot evidence is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_pool_immutable BEFORE UPDATE ON alpha_snapshot_pools
WHEN NEW.captured_at IS NOT OLD.captured_at OR NEW.hotkey IS NOT OLD.hotkey
 OR NEW.netuid IS NOT OLD.netuid OR NEW.evidence IS NOT OLD.evidence
BEGIN SELECT RAISE(ABORT,'Alpha pool evidence is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_snapshot_pool_preserve BEFORE DELETE ON alpha_snapshot_pools
BEGIN SELECT RAISE(ABORT,'Alpha pool evidence is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_position_capture_identity BEFORE UPDATE ON nominator_positions
WHEN OLD.alpha_evidence IS NOT NULL AND NEW.captured_at=OLD.captured_at
 AND (NEW.coldkey IS NOT OLD.coldkey OR NEW.hotkey IS NOT OLD.hotkey
   OR NEW.netuid IS NOT OLD.netuid OR NEW.source IS NOT OLD.source
   OR NEW.share_fraction IS NOT OLD.share_fraction OR NEW.shares IS NOT OLD.shares
   OR NEW.alpha_rao IS NOT OLD.alpha_rao OR NEW.alpha_evidence IS NOT OLD.alpha_evidence)
BEGIN SELECT RAISE(ABORT,'Alpha position evidence differs at the same capture'); END;
-- statement-breakpoint
-- An empty legacy prune cannot erase evidence. Only the receiver's complete,
-- newer-block promotion may retire an Alpha-owned latest row; originals stay.
CREATE TRIGGER alpha_position_delete_fence BEFORE DELETE ON nominator_positions
WHEN OLD.alpha_evidence IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM alpha_snapshot_passes p WHERE p.completed_at IS NULL
 AND p.received_rows=p.expected_rows AND p.received_chunks=p.expected_chunks
 AND p.captured_at<>OLD.captured_at AND NOT EXISTS(
   SELECT 1 FROM alpha_snapshot_passes selected
   WHERE selected.selected=1 AND selected.block_number>=p.block_number))
BEGIN SELECT RAISE(ABORT,'Alpha position retirement requires a complete newer snapshot'); END;
-- statement-breakpoint
-- Queue admission is not a count receipt. An anchored count pass names the
-- exact retained capture; historical terminal receipts remain restorable.
CREATE TRIGGER alpha_count_pass_insert_fence BEFORE INSERT ON validator_nominator_counts_passes
WHEN (NEW.alpha_snapshot IS NULL AND EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1))
 OR (NEW.alpha_snapshot IS NOT NULL AND NEW.alpha_snapshot IS NOT (
  SELECT json_object('captured_at',p.captured_at,'block_number',p.block_number,
   'block_hash',p.block_hash,'genesis_hash',p.genesis_hash,'spec_version',p.spec_version,
   'code_hash',p.code_hash,'metadata_sha256',p.metadata_sha256,
   'scanned_legacy',p.scanned_legacy,'scanned_v2',p.scanned_v2,
   'distinct_members',p.distinct_members,'excluded_root_members',p.excluded_root_members)
  FROM alpha_snapshot_passes p WHERE p.captured_at=NEW.captured_at
   AND p.selected=1 AND p.completed_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'Alpha counts require their exact retained capture'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_pass_update_fence BEFORE UPDATE ON validator_nominator_counts_passes
WHEN (NEW.alpha_snapshot IS NULL AND EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1))
 OR NEW.alpha_snapshot IS NOT OLD.alpha_snapshot
 OR (OLD.alpha_snapshot IS NOT NULL AND (NEW.captured_at IS NOT OLD.captured_at
  OR NEW.expected_rows IS NOT OLD.expected_rows OR NEW.received_rows<OLD.received_rows
  OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS NOT OLD.completed_at)))
BEGIN SELECT RAISE(ABORT,'Alpha count receipt identity is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_pass_insert_bounds BEFORE INSERT ON validator_nominator_counts_passes
WHEN NEW.alpha_snapshot IS NOT NULL AND (NEW.expected_rows<0
 OR NEW.expected_rows>json_extract(NEW.alpha_snapshot,'$.distinct_members')
 OR (NEW.expected_rows=0)<>(json_extract(NEW.alpha_snapshot,'$.distinct_members')=0)
 OR NEW.received_rows<0 OR NEW.received_rows>NEW.expected_rows
 OR (NEW.completed_at IS NOT NULL AND (NEW.completed_at<=0
  OR NEW.received_rows<>NEW.expected_rows)))
BEGIN SELECT RAISE(ABORT,'Alpha count receipt is incomplete or outside its census'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_pass_update_bounds BEFORE UPDATE ON validator_nominator_counts_passes
WHEN NEW.alpha_snapshot IS NOT NULL AND (NEW.expected_rows<0
 OR NEW.expected_rows>json_extract(NEW.alpha_snapshot,'$.distinct_members')
 OR (NEW.expected_rows=0)<>(json_extract(NEW.alpha_snapshot,'$.distinct_members')=0)
 OR NEW.received_rows<0 OR NEW.received_rows>NEW.expected_rows
 OR (NEW.completed_at IS NOT NULL AND (NEW.completed_at<=0
  OR NEW.received_rows<>NEW.expected_rows)))
BEGIN SELECT RAISE(ABORT,'Alpha count receipt is incomplete or outside its census'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_pass_preserve BEFORE DELETE ON validator_nominator_counts_passes
WHEN OLD.alpha_snapshot IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Alpha count receipt is retained'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_insert_fence BEFORE INSERT ON validator_nominator_counts
WHEN EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1)
 AND (NEW.captured_at IS NOT (SELECT captured_at FROM alpha_snapshot_passes WHERE selected=1
  ORDER BY block_number DESC,captured_at DESC LIMIT 1)
 OR NOT EXISTS(SELECT 1 FROM validator_nominator_counts_passes
  WHERE captured_at=NEW.captured_at AND alpha_snapshot IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'Alpha counts require the current canonical capture'); END;
-- statement-breakpoint
CREATE TRIGGER alpha_count_update_fence BEFORE UPDATE ON validator_nominator_counts
WHEN EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE selected=1)
 AND (NEW.captured_at IS NOT (SELECT captured_at FROM alpha_snapshot_passes WHERE selected=1
  ORDER BY block_number DESC,captured_at DESC LIMIT 1)
 OR NOT EXISTS(SELECT 1 FROM validator_nominator_counts_passes
  WHERE captured_at=NEW.captured_at AND alpha_snapshot IS NOT NULL)
 OR (NEW.captured_at=OLD.captured_at AND NEW.nominator_count IS NOT OLD.nominator_count))
BEGIN SELECT RAISE(ABORT,'Alpha count write is stale or differs at the same capture'); END;
