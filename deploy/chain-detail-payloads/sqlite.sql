-- PREPARED ONLY. No workflow applies this file. Quota remains zero until an
-- operator selects measured capacity and verifies a coherent source/restore.
-- Encoded bytes are neither physical D1 bytes nor process memory/IOPS.
-- Run the full bundle atomically with writers held; initial SUM is an explicit
-- whole-chunk census whose cost must be measured before approval/application.
CREATE TABLE chain_detail_payload_budget (
  id INTEGER PRIMARY KEY CHECK (id=1),
  max_encoded_bytes INTEGER NOT NULL CHECK (max_encoded_bytes>=0 AND max_encoded_bytes<=9007199254740991),
  used_encoded_bytes INTEGER NOT NULL CHECK (used_encoded_bytes>=0 AND used_encoded_bytes<=9007199254740991)
);
-- statement-breakpoint
INSERT INTO chain_detail_payload_budget(id,max_encoded_bytes,used_encoded_bytes)
SELECT 1,0,coalesce(sum(length(data)),0) FROM chain_detail_payload_chunks;
-- statement-breakpoint
CREATE TRIGGER chain_detail_payload_budget_insert BEFORE INSERT ON chain_detail_payload_chunks
WHEN NOT EXISTS (SELECT 1 FROM chain_detail_payload_chunks WHERE sha256=NEW.sha256 AND part=NEW.part)
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM chain_detail_payload_budget
    WHERE id=1 AND length(NEW.data)<=max_encoded_bytes-used_encoded_bytes)
    THEN RAISE(ABORT,'native payload encoded-byte quota exhausted') END;
END;
-- statement-breakpoint
CREATE TRIGGER chain_detail_payload_budget_inserted AFTER INSERT ON chain_detail_payload_chunks
BEGIN
  UPDATE chain_detail_payload_budget SET used_encoded_bytes=used_encoded_bytes+length(NEW.data) WHERE id=1;
END;
-- statement-breakpoint
CREATE TRIGGER chain_detail_payload_budget_update BEFORE UPDATE ON chain_detail_payload_chunks
BEGIN
  SELECT CASE WHEN NEW.sha256!=OLD.sha256 OR NEW.part!=OLD.part OR NEW.data!=OLD.data
    THEN RAISE(ABORT,'native payload chunks are immutable') END;
END;
-- statement-breakpoint
CREATE TRIGGER chain_detail_payload_budget_deleted AFTER DELETE ON chain_detail_payload_chunks
BEGIN
  UPDATE chain_detail_payload_budget SET used_encoded_bytes=used_encoded_bytes-length(OLD.data) WHERE id=1;
END;
