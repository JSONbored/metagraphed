-- Lossless compressed raw captures. Selection happens only after byte readback.
-- The staging budget bounds growth if the existing archive consumer is delayed.
CREATE TABLE raw_capture_budget (
  id INTEGER PRIMARY KEY CHECK(id=1),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 536870912),
  objects INTEGER NOT NULL DEFAULT 0 CHECK(objects BETWEEN 0 AND 16384)
);
INSERT INTO raw_capture_budget(id) VALUES(1);
CREATE TABLE raw_capture_batches (
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
  complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
  PRIMARY KEY(key,sha256)
) WITHOUT ROWID;
CREATE TRIGGER raw_capture_reserve AFTER INSERT ON raw_capture_batches BEGIN
  UPDATE raw_capture_budget SET bytes=bytes+NEW.compressed_bytes,objects=objects+1 WHERE id=1;
END;
CREATE TRIGGER raw_capture_release AFTER DELETE ON raw_capture_batches BEGIN
  UPDATE raw_capture_budget SET bytes=bytes-OLD.compressed_bytes,objects=objects-1 WHERE id=1;
END;
CREATE TABLE raw_capture_chunks (
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  part INTEGER NOT NULL CHECK(part BETWEEN 0 AND 512),
  data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 65536),
  PRIMARY KEY(key,sha256,part),
  FOREIGN KEY(key,sha256) REFERENCES raw_capture_batches(key,sha256) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TABLE raw_capture_selected (
  key TEXT PRIMARY KEY NOT NULL,
  sha256 TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  last_block INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  FOREIGN KEY(key,sha256) REFERENCES raw_capture_batches(key,sha256)
) WITHOUT ROWID;
CREATE INDEX raw_capture_selected_network_block ON raw_capture_selected(network,last_block,key);
