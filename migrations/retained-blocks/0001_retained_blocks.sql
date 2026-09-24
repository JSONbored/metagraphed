-- Separate D1 database: complete retained blocks, never application state.
-- Source identity plus physical ordinal preserves duplicates across files.
CREATE TABLE IF NOT EXISTS history_block_sources (
  id INTEGER PRIMARY KEY,
  identity TEXT NOT NULL UNIQUE,
  network INTEGER NOT NULL CHECK(network IN (0,1)),
  source TEXT NOT NULL,
  expected_rows INTEGER NOT NULL CHECK(expected_rows >= 0),
  received_rows INTEGER NOT NULL DEFAULT 0 CHECK(received_rows >= 0 AND received_rows <= expected_rows),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1))
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_block_authors (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE
);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_blocks (
  network INTEGER NOT NULL CHECK(network IN (0,1)),
  source_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  block_number INTEGER,
  block_hash TEXT,
  parent_hash TEXT,
  author_id INTEGER,
  extrinsic_count INTEGER,
  event_count INTEGER,
  spec_version INTEGER,
  observed_at INTEGER,
  PRIMARY KEY(source_id,ordinal)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_order ON history_blocks(network,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_author ON history_blocks(network,author_id,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_spec ON history_blocks(network,spec_version,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_author_spec ON history_blocks(network,author_id,spec_version,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_extrinsics ON history_blocks(network,extrinsic_count,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_events ON history_blocks(network,event_count,observed_at DESC,block_number DESC);
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS history_blocks_height ON history_blocks(network,block_number,observed_at DESC);
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_block_chunks (
  source_id INTEGER NOT NULL,
  start_row INTEGER NOT NULL,
  rows INTEGER NOT NULL CHECK(rows > 0),
  digest TEXT NOT NULL,
  PRIMARY KEY(source_id,start_row)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_block_source_counts (
  source_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('events','extrinsics')),
  value INTEGER NOT NULL,
  rows INTEGER NOT NULL CHECK(rows > 0),
  PRIMARY KEY(source_id,kind,value)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_block_counts (
  network INTEGER NOT NULL CHECK(network IN (0,1)),
  kind TEXT NOT NULL CHECK(kind IN ('events','extrinsics')),
  value INTEGER NOT NULL,
  rows INTEGER NOT NULL CHECK(rows > 0),
  PRIMARY KEY(network,kind,value)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE IF NOT EXISTS history_block_state (
  network INTEGER PRIMARY KEY CHECK(network IN (0,1)),
  generation TEXT NOT NULL,
  table_uuid TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  source_rows INTEGER NOT NULL,
  source_files INTEGER NOT NULL,
  coverage TEXT
);
-- statement-breakpoint
CREATE VIEW IF NOT EXISTS history_block_rows AS
SELECT b.network,b.block_number,b.block_hash,b.parent_hash,a.address AS author,
       b.extrinsic_count,b.event_count,b.spec_version,b.observed_at
FROM history_blocks b
JOIN history_block_sources s ON s.id=b.source_id AND s.network=b.network AND s.active=1
LEFT JOIN history_block_authors a ON a.id=b.author_id;
