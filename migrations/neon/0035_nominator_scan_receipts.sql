-- #11997: preserve full-scan delivery evidence independently of the mutable
-- position ledger. One coldkey is never split across chunks, so replacing its
-- receipt on replay is idempotent. Self-stake never writes this table.
CREATE TABLE IF NOT EXISTS nominator_scan_receipts (
  captured_at BIGINT NOT NULL,
  coldkey TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  PRIMARY KEY (captured_at, coldkey)
);
