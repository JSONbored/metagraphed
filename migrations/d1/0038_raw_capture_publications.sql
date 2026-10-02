-- A mutable latest selector cannot acknowledge an earlier committed capture.
-- Preserve exact publication receipts after another capture or native archive
-- moves the selector; the immutable source bytes retain their original SHA.
CREATE TABLE raw_capture_publications (
  key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  selected_sha256 TEXT NOT NULL CHECK (length(selected_sha256) = 64),
  chain_sha256 TEXT CHECK (chain_sha256 IS NULL OR length(chain_sha256) = 64),
  PRIMARY KEY (key,sha256)
) WITHOUT ROWID;
-- statement-breakpoint
-- Only present, complete selections establish legacy publication. Do not infer
-- that every older complete capture was ever selected.
INSERT INTO raw_capture_publications(key,sha256,selected_sha256,chain_sha256)
SELECT s.key,s.sha256,s.sha256,NULL FROM raw_capture_selected s
JOIN raw_capture_batches b USING(key,sha256)
WHERE b.complete=1 AND s.network=b.network AND s.last_block=b.last_block
  AND s.captured_at=b.captured_at
  AND b.parts=(SELECT count(*) FROM raw_capture_chunks c WHERE c.key=b.key AND c.sha256=b.sha256)
  AND b.compressed_bytes=(SELECT sum(length(data)) FROM raw_capture_chunks c WHERE c.key=b.key AND c.sha256=b.sha256)
UNION
SELECT key,sha256,sha256,NULL FROM raw_capture_archives
WHERE selected=1 AND complete=1 AND native_sha256=compressed_sha256
  AND native_key='chain/raw/native/v1/'||network||'/'||sha256||'/'||compressed_sha256||'.gz';
