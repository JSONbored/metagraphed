-- Verified native copies replace staging bytes without losing raw identities.
CREATE TABLE raw_capture_archives (
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  first_block INTEGER NOT NULL CHECK(first_block>=0),
  last_block INTEGER NOT NULL CHECK(last_block>=first_block),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes BETWEEN 1 AND 33554432),
  compressed_bytes INTEGER NOT NULL CHECK(compressed_bytes BETWEEN 1 AND 33619968),
  compressed_sha256 TEXT NOT NULL CHECK(length(compressed_sha256)=64),
  parts INTEGER NOT NULL CHECK(parts BETWEEN 1 AND 513),
  captured_at INTEGER NOT NULL CHECK(captured_at>0),
  complete INTEGER NOT NULL CHECK(complete=1),
  selected INTEGER NOT NULL CHECK(selected IN (0,1)),
  native_key TEXT NOT NULL,
  native_etag TEXT NOT NULL CHECK(length(native_etag)=32),
  native_sha256 TEXT NOT NULL CHECK(native_sha256=compressed_sha256),
  PRIMARY KEY(key,sha256)
) WITHOUT ROWID;
CREATE INDEX raw_capture_archives_network_block
  ON raw_capture_archives(network,last_block,key) WHERE selected=1;
CREATE TRIGGER raw_capture_archive_source BEFORE INSERT ON raw_capture_archives BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM raw_capture_batches b
    WHERE b.key=NEW.key AND b.sha256=NEW.sha256 AND b.complete=1
      AND b.network=NEW.network AND b.first_block=NEW.first_block AND b.last_block=NEW.last_block
      AND b.raw_bytes=NEW.raw_bytes AND b.compressed_bytes=NEW.compressed_bytes
      AND b.compressed_sha256=NEW.compressed_sha256 AND b.parts=NEW.parts AND b.captured_at=NEW.captured_at
      AND NEW.parts=(SELECT count(*) FROM raw_capture_chunks c WHERE c.key=b.key AND c.sha256=b.sha256)
      AND NEW.compressed_bytes=(SELECT sum(length(data)) FROM raw_capture_chunks c WHERE c.key=b.key AND c.sha256=b.sha256)
      AND NEW.selected=EXISTS(SELECT 1 FROM raw_capture_selected s WHERE s.key=b.key AND s.sha256=b.sha256)
  ) THEN RAISE(ABORT,'Raw archive source changed') END;
END;
-- The archive row, selector transition, chunk deletion and budget release are
-- one SQLite statement. An uncertain response must be reconciled by reading it.
CREATE TRIGGER raw_capture_archive_release AFTER INSERT ON raw_capture_archives BEGIN
  UPDATE raw_capture_archives SET selected=0
    WHERE key=NEW.key AND sha256<>NEW.sha256 AND NEW.selected=1;
  DELETE FROM raw_capture_selected WHERE key=NEW.key AND sha256=NEW.sha256;
  DELETE FROM raw_capture_batches WHERE key=NEW.key AND sha256=NEW.sha256;
END;
