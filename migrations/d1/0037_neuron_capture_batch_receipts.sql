-- Incomplete receipts remain until their complete pass makes recounting impossible.
CREATE TABLE neurons_capture_batches (
  batch_id TEXT NOT NULL PRIMARY KEY CHECK (length(batch_id) = 64),
  captured_at INTEGER NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1))
);
-- statement-breakpoint
CREATE INDEX idx_neurons_capture_batches_capture
  ON neurons_capture_batches (captured_at,batch_id);
