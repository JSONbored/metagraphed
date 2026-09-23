-- Keep the small axon field beside the existing stable day/slot index. The
-- metric documents remain authoritative; triggers cover every writer.
ALTER TABLE neuron_daily_members ADD COLUMN axon_index BLOB;
-- statement-breakpoint
ALTER TABLE neuron_daily_members ADD COLUMN axon_indexed INTEGER NOT NULL DEFAULT 0 CHECK(axon_indexed IN (0,1));
-- statement-breakpoint
CREATE INDEX neuron_daily_axon_pending_idx ON neuron_daily_members(netuid,uid,snapshot_date) WHERE axon_indexed=0;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_member_insert AFTER INSERT ON neuron_daily_members
BEGIN
 UPDATE neuron_daily_members SET
 axon_index=(SELECT json_extract(d.payload,'$."'||NEW.uid||'".axon') FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard),
 axon_indexed=1
 WHERE netuid=NEW.netuid AND uid=NEW.uid AND snapshot_date=NEW.snapshot_date
 AND EXISTS(SELECT 1 FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard);
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_document_insert AFTER INSERT ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=json_extract(NEW.payload,'$."'||uid||'".axon'),axon_indexed=1
 WHERE netuid=NEW.netuid AND snapshot_date=NEW.day AND shard=NEW.shard;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_document_update AFTER UPDATE OF payload ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=json_extract(NEW.payload,'$."'||uid||'".axon'),axon_indexed=1
 WHERE netuid=NEW.netuid AND snapshot_date=NEW.day AND shard=NEW.shard
 AND (axon_indexed=0 OR axon_index IS NOT json_extract(NEW.payload,'$."'||uid||'".axon'));
END;

-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_member_move AFTER UPDATE OF netuid,uid,snapshot_date,shard ON neuron_daily_members
BEGIN
 UPDATE neuron_daily_members SET
 axon_index=(SELECT json_extract(d.payload,'$."'||NEW.uid||'".axon') FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard),
 axon_indexed=CASE WHEN EXISTS(SELECT 1 FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard) THEN 1 ELSE 0 END
 WHERE netuid=NEW.netuid AND uid=NEW.uid AND snapshot_date=NEW.snapshot_date;
END;
