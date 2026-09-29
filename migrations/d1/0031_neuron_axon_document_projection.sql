-- Expand each accepted document once before refreshing its small axon index.
-- Keep missing members as NULL and preserve the first duplicate JSON key,
-- matching the original JSON-path lookup for legacy/import writers.
DROP TRIGGER neuron_daily_axon_document_insert;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_document_insert AFTER INSERT ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=accepted.axon,axon_indexed=1
 FROM (
  WITH payload AS MATERIALIZED (
   SELECT key,CASE WHEN type='object' THEN json_extract(value,'$.axon') END AS axon,
     MIN(id) AS first_id
   FROM json_each(NEW.payload) WHERE typeof(key)='text' GROUP BY key
  )
  SELECT m.netuid,m.uid,m.snapshot_date,p.axon
  FROM neuron_daily_members m LEFT JOIN payload p ON p.key=CAST(m.uid AS TEXT)
  WHERE m.netuid=NEW.netuid AND m.snapshot_date=NEW.day AND m.shard=NEW.shard
 ) AS accepted
 WHERE neuron_daily_members.netuid=accepted.netuid
   AND neuron_daily_members.uid=accepted.uid
   AND neuron_daily_members.snapshot_date=accepted.snapshot_date;
END;
-- statement-breakpoint
DROP TRIGGER neuron_daily_axon_document_update;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_axon_document_update AFTER UPDATE OF payload ON neuron_daily_documents
BEGIN
 UPDATE neuron_daily_members SET axon_index=accepted.axon,axon_indexed=1
 FROM (
  WITH payload AS MATERIALIZED (
   SELECT key,CASE WHEN type='object' THEN json_extract(value,'$.axon') END AS axon,
     MIN(id) AS first_id
   FROM json_each(NEW.payload) WHERE typeof(key)='text' GROUP BY key
  )
  SELECT m.netuid,m.uid,m.snapshot_date,p.axon
  FROM neuron_daily_members m LEFT JOIN payload p ON p.key=CAST(m.uid AS TEXT)
  WHERE m.netuid=NEW.netuid AND m.snapshot_date=NEW.day AND m.shard=NEW.shard
 ) AS accepted
 WHERE neuron_daily_members.netuid=accepted.netuid
   AND neuron_daily_members.uid=accepted.uid
   AND neuron_daily_members.snapshot_date=accepted.snapshot_date
   AND (neuron_daily_members.axon_indexed=0
        OR neuron_daily_members.axon_index IS NOT accepted.axon);
END;
