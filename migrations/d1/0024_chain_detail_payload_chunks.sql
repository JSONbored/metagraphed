-- Large, poorly compressible calls cannot fit within one chain-detail row.
-- Each immutable base64 chunk remains below D1's 2,000,000-byte row limit.
CREATE TABLE IF NOT EXISTS chain_detail_payload_chunks (
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  part INTEGER NOT NULL CHECK (part >= 0 AND part < 12),
  data TEXT NOT NULL CHECK (length(data) <= 1986668),
  PRIMARY KEY (sha256, part)
) WITHOUT ROWID;
