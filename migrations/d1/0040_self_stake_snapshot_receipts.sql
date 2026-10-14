-- A complete self-stake scan owns only its latest-only source domain. Keep
-- exact chunk receipts separate from the Alpha scan's completeness ledger.
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
    PRIMARY KEY (captured_at,batch_index),
    CHECK ((row_count = 0 AND first_owner IS NULL AND last_owner IS NULL) OR
           (row_count > 0 AND first_owner IS NOT NULL AND last_owner >= first_owner))
) WITHOUT ROWID;
