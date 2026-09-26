-- Failed sync deliveries remain recoverable independently of Queue retention.
-- No automatic expiry: remove only after verified recovery or explicit disposal.
CREATE TABLE IF NOT EXISTS sync_dead_letters (
  message_id TEXT PRIMARY KEY NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  encoding TEXT NOT NULL CHECK (encoding IN ('json', 'base64')),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB)) <= 174764),
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_dead_letters_received_idx ON sync_dead_letters(received_at);
