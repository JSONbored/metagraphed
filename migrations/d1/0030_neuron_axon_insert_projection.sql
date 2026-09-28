-- The canonical capture writer supplies the axon from its already-expanded
-- accepted document. Avoid a second per-member document read and UPDATE when
-- a new UTC day creates every membership. Legacy/import writers still derive
-- the field here; document corrections and member moves retain their triggers.
DROP TRIGGER neuron_daily_axon_member_insert;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_member_insert AFTER INSERT ON neuron_daily_members
WHEN NEW.axon_indexed=0
BEGIN
 UPDATE neuron_daily_members SET
 axon_index=(SELECT json_extract(d.payload,'$."'||NEW.uid||'".axon') FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard),
 axon_indexed=1
 WHERE netuid=NEW.netuid AND uid=NEW.uid AND snapshot_date=NEW.snapshot_date
 AND EXISTS(SELECT 1 FROM neuron_daily_documents d WHERE d.netuid=NEW.netuid AND d.day=NEW.snapshot_date AND d.shard=NEW.shard);
END;
