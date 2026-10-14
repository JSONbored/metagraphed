-- Preserve every existing frontier as legacy/unverified. No inferred genesis,
-- rewind, floor change, byte replacement or historical completeness backfill.
ALTER TABLE raw_capture_state ADD COLUMN genesis_hash TEXT;
-- statement-breakpoint
ALTER TABLE raw_capture_state ADD COLUMN frontier_hash TEXT;
-- statement-breakpoint
ALTER TABLE raw_capture_state ADD COLUMN verified_from INTEGER;
-- statement-breakpoint
ALTER TABLE raw_capture_state ADD COLUMN finalized_height INTEGER;
-- statement-breakpoint
ALTER TABLE raw_capture_state ADD COLUMN finalized_hash TEXT;
-- statement-breakpoint
ALTER TABLE raw_capture_state ADD COLUMN checkpoint_revision INTEGER NOT NULL DEFAULT 0;
-- statement-breakpoint
-- A proof belongs to an immutable publication, not a disposable staging row.
-- Native archival releases chunks but retains this relationship and original SHA.
CREATE TABLE raw_capture_finality (
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  chain_sha256 TEXT NOT NULL CHECK(length(chain_sha256)=64),
  genesis_hash TEXT NOT NULL CHECK(length(genesis_hash)=66),
  first_block INTEGER NOT NULL CHECK(typeof(first_block)='integer' AND first_block BETWEEN 0 AND 4294967295),
  last_block INTEGER NOT NULL CHECK(typeof(last_block)='integer' AND last_block BETWEEN first_block AND 4294967295),
  parent_hash TEXT NOT NULL CHECK(length(parent_hash)=66),
  frontier_hash TEXT NOT NULL CHECK(length(frontier_hash)=66),
  finalized_height INTEGER NOT NULL CHECK(typeof(finalized_height)='integer' AND finalized_height BETWEEN last_block AND 4294967295),
  finalized_hash TEXT NOT NULL CHECK(length(finalized_hash)=66),
  verified_from INTEGER NOT NULL CHECK(typeof(verified_from)='integer' AND verified_from BETWEEN 0 AND first_block),
  PRIMARY KEY(network,revision),
  UNIQUE(key,chain_sha256),
  FOREIGN KEY(key,sha256) REFERENCES raw_capture_publications(key,sha256)
) WITHOUT ROWID;
-- statement-breakpoint
-- Reject partially initialized anchors, including direct legacy writers.
CREATE TRIGGER raw_capture_checkpoint_shape_insert BEFORE INSERT ON raw_capture_state
WHEN EXISTS(SELECT 1 FROM raw_capture_state WHERE network=NEW.network AND genesis_hash IS NOT NULL) OR COALESCE((
  typeof(NEW.last_contiguous_block)='integer' AND NEW.last_contiguous_block BETWEEN -1 AND 4294967295
  AND typeof(NEW.checkpoint_revision)='integer' AND NEW.checkpoint_revision BETWEEN 0 AND 9007199254740991
  AND ((NEW.genesis_hash IS NULL AND NEW.frontier_hash IS NULL AND NEW.verified_from IS NULL
    AND NEW.finalized_height IS NULL AND NEW.finalized_hash IS NULL AND NEW.checkpoint_revision=0)
  OR (NEW.checkpoint_revision=0 AND length(NEW.genesis_hash)=66 AND length(NEW.frontier_hash)=66 AND length(NEW.finalized_hash)=66
    AND typeof(NEW.verified_from)='integer' AND NEW.verified_from=NEW.last_contiguous_block+1
    AND typeof(NEW.finalized_height)='integer' AND NEW.finalized_height BETWEEN NEW.last_contiguous_block AND 4294967295))
),0)=0 BEGIN SELECT RAISE(ABORT,'Invalid raw capture checkpoint'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_checkpoint_guard BEFORE UPDATE ON raw_capture_state
WHEN (
  NEW.network IS NOT OLD.network OR typeof(NEW.last_contiguous_block)<>'integer' OR NEW.last_contiguous_block NOT BETWEEN -1 AND 4294967295
  OR typeof(NEW.checkpoint_revision)<>'integer' OR NEW.checkpoint_revision NOT BETWEEN 0 AND 9007199254740991
  OR (OLD.genesis_hash IS NULL AND COALESCE(NOT (
    (NEW.genesis_hash IS NULL AND NEW.frontier_hash IS NULL AND NEW.verified_from IS NULL
      AND NEW.finalized_height IS NULL AND NEW.finalized_hash IS NULL AND NEW.checkpoint_revision=0)
    OR (NEW.last_contiguous_block=OLD.last_contiguous_block AND NEW.checkpoint_revision=0
      AND length(NEW.genesis_hash)=66 AND length(NEW.frontier_hash)=66 AND length(NEW.finalized_hash)=66
      AND typeof(NEW.verified_from)='integer' AND NEW.verified_from=NEW.last_contiguous_block+1
      AND typeof(NEW.finalized_height)='integer' AND NEW.finalized_height BETWEEN NEW.last_contiguous_block AND 4294967295)),1))
  OR (OLD.genesis_hash IS NOT NULL AND (
    NEW.genesis_hash IS NOT OLD.genesis_hash OR NEW.verified_from IS NOT OLD.verified_from
    OR NEW.last_contiguous_block<OLD.last_contiguous_block
    OR NEW.finalized_height<OLD.finalized_height
    OR (NEW.finalized_height=OLD.finalized_height AND NEW.finalized_hash IS NOT OLD.finalized_hash)
    OR (NEW.last_contiguous_block=OLD.last_contiguous_block AND (
      NEW.frontier_hash IS NOT OLD.frontier_hash OR NEW.checkpoint_revision<>OLD.checkpoint_revision
      OR NEW.finalized_height IS NOT OLD.finalized_height OR NEW.finalized_hash IS NOT OLD.finalized_hash))
    OR (NEW.last_contiguous_block>OLD.last_contiguous_block AND NOT EXISTS (
      SELECT 1 FROM raw_capture_finality f WHERE f.network=OLD.network
        AND f.revision=OLD.checkpoint_revision+1 AND NEW.checkpoint_revision=f.revision
        AND f.genesis_hash=OLD.genesis_hash AND f.verified_from=OLD.verified_from
        AND f.first_block=OLD.last_contiguous_block+1 AND f.parent_hash=OLD.frontier_hash
        AND f.last_block=NEW.last_contiguous_block AND f.frontier_hash=NEW.frontier_hash
        AND f.finalized_height=NEW.finalized_height AND f.finalized_hash=NEW.finalized_hash))))
) BEGIN SELECT RAISE(ABORT,'Raw capture checkpoint proof required'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_finality_immutable BEFORE UPDATE ON raw_capture_finality
BEGIN SELECT RAISE(ABORT,'Raw capture finality is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_finality_preserve BEFORE DELETE ON raw_capture_finality
BEGIN SELECT RAISE(ABORT,'Raw capture finality is retained'); END;

-- statement-breakpoint
CREATE TRIGGER raw_capture_checkpoint_preserve BEFORE DELETE ON raw_capture_state
WHEN OLD.genesis_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Anchored raw capture checkpoint is retained'); END;

-- statement-breakpoint
-- Publication and the exact CAS are indivisible even when a trigger refuses
-- an UPDATE without a SQL error. A zero-row frontier change aborts the batch.
CREATE TRIGGER raw_capture_finality_commit AFTER INSERT ON raw_capture_finality BEGIN
  UPDATE raw_capture_state SET
    last_contiguous_block=NEW.last_block,frontier_hash=NEW.frontier_hash,
    finalized_height=NEW.finalized_height,finalized_hash=NEW.finalized_hash,
    checkpoint_revision=NEW.revision,
    updated_at=(SELECT captured_at FROM raw_capture_batches WHERE key=NEW.key AND sha256=NEW.sha256),
    stopped_at=NULL,last_error=NULL
  WHERE network=NEW.network AND genesis_hash=NEW.genesis_hash AND verified_from=NEW.verified_from
    AND checkpoint_revision=NEW.revision-1 AND last_contiguous_block=NEW.first_block-1
    AND frontier_hash=NEW.parent_hash AND finalized_height<=NEW.finalized_height
    AND (finalized_height<NEW.finalized_height OR finalized_hash=NEW.finalized_hash);
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM raw_capture_state WHERE network=NEW.network
    AND checkpoint_revision=NEW.revision AND last_contiguous_block=NEW.last_block
    AND genesis_hash=NEW.genesis_hash AND verified_from=NEW.verified_from
    AND frontier_hash=NEW.frontier_hash AND finalized_height=NEW.finalized_height
    AND finalized_hash=NEW.finalized_hash)
    THEN RAISE(ABORT,'Raw capture frontier CAS refused') END;
  -- Selection belongs to this same proof transaction. A previous runtime's
  -- timestamp-based selector upsert has no proof and is refused by the guards.
  INSERT INTO raw_capture_selected(key,sha256,network,last_block,captured_at)
    SELECT key,sha256,network,last_block,captured_at FROM raw_capture_batches
    WHERE key=NEW.key AND sha256=NEW.sha256 AND complete=1
    ON CONFLICT(key) DO UPDATE SET sha256=excluded.sha256,network=excluded.network,
      last_block=excluded.last_block,captured_at=excluded.captured_at;
  UPDATE raw_capture_archives SET selected=0 WHERE key=NEW.key AND sha256<>NEW.sha256
    AND NOT EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=raw_capture_archives.key AND f.sha256=raw_capture_archives.sha256);
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM raw_capture_selected WHERE key=NEW.key AND sha256=NEW.sha256 AND network=NEW.network AND last_block=NEW.last_block)
    THEN RAISE(ABORT,'Raw capture selector CAS refused') END;
END;

-- statement-breakpoint
-- A canonical proof cannot survive mutations of the publication it certifies.
CREATE TRIGGER raw_capture_canonical_publication_immutable BEFORE UPDATE ON raw_capture_publications
WHEN EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=OLD.key AND (f.sha256=OLD.sha256 OR f.chain_sha256=OLD.chain_sha256))
BEGIN SELECT RAISE(ABORT,'Canonical raw publication is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_canonical_publication_preserve BEFORE DELETE ON raw_capture_publications
WHEN EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=OLD.key AND (f.sha256=OLD.sha256 OR f.chain_sha256=OLD.chain_sha256))
BEGIN SELECT RAISE(ABORT,'Canonical raw publication is retained'); END;

-- statement-breakpoint
CREATE TRIGGER raw_capture_selected_canonical_insert BEFORE INSERT ON raw_capture_selected
WHEN EXISTS(SELECT 1 FROM raw_capture_state c WHERE c.network=NEW.network AND c.genesis_hash IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM raw_capture_finality f
   JOIN raw_capture_state c ON c.network=f.network AND c.genesis_hash=f.genesis_hash AND c.verified_from=f.verified_from AND c.checkpoint_revision>=f.revision AND c.last_contiguous_block>=f.last_block
   JOIN raw_capture_publications p ON p.key=f.key AND p.sha256=f.sha256 AND p.chain_sha256=f.chain_sha256
   JOIN raw_capture_batches b ON b.key=f.key AND b.sha256=f.sha256 AND b.complete=1
   WHERE f.key=NEW.key AND f.sha256=NEW.sha256 AND f.network=NEW.network AND f.last_block=NEW.last_block AND b.captured_at=NEW.captured_at)
BEGIN SELECT RAISE(ABORT,'Canonical raw selector proof required'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_selected_canonical_update BEFORE UPDATE ON raw_capture_selected
WHEN EXISTS(SELECT 1 FROM raw_capture_state c WHERE c.network IN (OLD.network,NEW.network) AND c.genesis_hash IS NOT NULL)
 AND (NEW.key IS NOT OLD.key OR NOT EXISTS(SELECT 1 FROM raw_capture_finality f
   JOIN raw_capture_state c ON c.network=f.network AND c.genesis_hash=f.genesis_hash AND c.verified_from=f.verified_from AND c.checkpoint_revision>=f.revision AND c.last_contiguous_block>=f.last_block
   JOIN raw_capture_publications p ON p.key=f.key AND p.sha256=f.sha256 AND p.chain_sha256=f.chain_sha256
   JOIN raw_capture_batches b ON b.key=f.key AND b.sha256=f.sha256 AND b.complete=1
   WHERE f.key=NEW.key AND f.sha256=NEW.sha256 AND f.network=NEW.network AND f.last_block=NEW.last_block AND b.captured_at=NEW.captured_at))
BEGIN SELECT RAISE(ABORT,'Canonical raw selector proof required'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_selected_canonical_release BEFORE DELETE ON raw_capture_selected
WHEN EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=OLD.key AND f.sha256=OLD.sha256)
 AND NOT EXISTS(SELECT 1 FROM raw_capture_archives a WHERE a.key=OLD.key AND a.sha256=OLD.sha256 AND a.complete=1 AND a.selected=1
   AND a.native_sha256=a.compressed_sha256 AND a.native_key='chain/raw/native/v1/'||a.network||'/'||a.sha256||'/'||a.compressed_sha256||'.gz')
BEGIN SELECT RAISE(ABORT,'Canonical raw selector requires native archive handoff'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_archive_canonical_insert BEFORE INSERT ON raw_capture_archives
WHEN NEW.selected=1 AND EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=NEW.key AND f.sha256<>NEW.sha256)
BEGIN SELECT RAISE(ABORT,'Canonical raw archive selection is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_archive_canonical_update BEFORE UPDATE ON raw_capture_archives
WHEN EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=OLD.key AND f.sha256=OLD.sha256)
 OR (NEW.selected=1 AND EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=NEW.key AND f.sha256<>NEW.sha256))
BEGIN SELECT RAISE(ABORT,'Canonical raw archive selection is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER raw_capture_archive_canonical_preserve BEFORE DELETE ON raw_capture_archives
WHEN EXISTS(SELECT 1 FROM raw_capture_finality f WHERE f.key=OLD.key AND f.sha256=OLD.sha256)
BEGIN SELECT RAISE(ABORT,'Canonical raw archive is retained'); END;
