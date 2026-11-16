-- Explicit native queue transport. No producer binding, polling loop or consumer
-- activation is installed by this migration.
CREATE SCHEMA IF NOT EXISTS jobs;

CREATE TABLE jobs.queues (
  name text COLLATE "C" PRIMARY KEY,
  max_batch_size integer NOT NULL CHECK (max_batch_size BETWEEN 1 AND 100),
  max_batch_timeout integer NOT NULL CHECK (max_batch_timeout BETWEEN 0 AND 60),
  max_retries integer NOT NULL CHECK (max_retries BETWEEN 0 AND 100),
  max_concurrency integer NOT NULL CHECK (max_concurrency BETWEEN 1 AND 100),
  retry_delay integer NOT NULL CHECK (retry_delay BETWEEN 0 AND 86400),
  dead_letter_queue text COLLATE "C" REFERENCES jobs.queues(name)
);
INSERT INTO jobs.queues VALUES
  ('probe-jobs-dlq',100,30,0,1,0,NULL),
  ('webhook-deliveries-dlq',100,30,0,1,0,NULL),
  ('sync-batches-dlq',100,30,100,1,600,NULL),
  ('probe-jobs',5,15,3,2,0,'probe-jobs-dlq'),
  ('webhook-deliveries',10,5,8,4,0,'webhook-deliveries-dlq'),
  ('sync-batches',10,5,5,2,0,'sync-batches-dlq');

CREATE TABLE jobs.capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_messages bigint NOT NULL CHECK (max_messages BETWEEN 1 AND 100000),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 1073741824),
  message_count bigint NOT NULL DEFAULT 0 CHECK (message_count BETWEEN 0 AND max_messages),
  body_bytes bigint NOT NULL DEFAULT 0 CHECK (body_bytes BETWEEN 0 AND max_bytes)
);

CREATE TABLE jobs.deliveries (
  id uuid PRIMARY KEY,
  queue text COLLATE "C" NOT NULL REFERENCES jobs.queues(name),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991)
);
CREATE INDEX deliveries_queue_expiry ON jobs.deliveries(queue,expires_at_ms);

CREATE TABLE jobs.messages (
  id uuid PRIMARY KEY,
  queue text COLLATE "C" NOT NULL REFERENCES jobs.queues(name),
  content_type text NOT NULL CHECK (content_type IN ('json','text','bytes')),
  body bytea NOT NULL CHECK (octet_length(body) <= 131072),
  created_at_ms bigint NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  available_at_ms bigint NOT NULL CHECK (available_at_ms BETWEEN 0 AND 9007199254740991),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 101),
  delivery_id uuid REFERENCES jobs.deliveries(id),
  original_queue text COLLATE "C" NOT NULL REFERENCES jobs.queues(name),
  original_attempts integer NOT NULL DEFAULT 0 CHECK (original_attempts BETWEEN 0 AND 101),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','parked')),
  parked_at_ms bigint CHECK (parked_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((state = 'parked') = (parked_at_ms IS NOT NULL)),
  CHECK (state <> 'parked' OR delivery_id IS NULL),
  CHECK (content_type <> 'json' OR convert_from(body,'UTF8')::json IS NOT NULL)
);
CREATE INDEX messages_due ON jobs.messages(queue,available_at_ms,created_at_ms,id) WHERE state='pending';
CREATE INDEX messages_delivery ON jobs.messages(delivery_id) WHERE delivery_id IS NOT NULL;

CREATE FUNCTION jobs.count_payload() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,jobs,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE jobs.capacity SET message_count = message_count + 1,
      body_bytes = body_bytes + octet_length(NEW.body) WHERE singleton;
  ELSE
    UPDATE jobs.capacity SET message_count = message_count - 1,
      body_bytes = body_bytes - octet_length(OLD.body) WHERE singleton;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'native queue capacity is not configured'; END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER queue_payload_capacity AFTER INSERT OR DELETE ON jobs.messages
FOR EACH ROW EXECUTE FUNCTION jobs.count_payload();

CREATE FUNCTION jobs.preserve_payload() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,jobs,pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.body <> OLD.body OR NEW.content_type <> OLD.content_type
    OR NEW.created_at_ms <> OLD.created_at_ms OR NEW.original_queue <> OLD.original_queue THEN
    RAISE EXCEPTION 'native queue payload and identity are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER queue_payload_immutable BEFORE UPDATE ON jobs.messages
FOR EACH ROW EXECUTE FUNCTION jobs.preserve_payload();
