-- Native webhook intent and attempt evidence. Payloads are shared by event,
-- retained on the existing180-day status horizon, never stored with secrets.
CREATE TABLE webhook_delivery_events (
  event_id TEXT PRIMARY KEY CHECK(length(event_id)=32),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 131072),
  created_at INTEGER NOT NULL CHECK(created_at>0),
  expires_at INTEGER NOT NULL CHECK(expires_at>=created_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER webhook_delivery_event_identity BEFORE UPDATE ON webhook_delivery_events
WHEN NEW.event_id IS NOT OLD.event_id OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.body IS NOT OLD.body OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'Webhook event identity is immutable'); END;
-- statement-breakpoint
CREATE TABLE webhook_delivery_intents (
  subscription_id TEXT NOT NULL CHECK(length(subscription_id) BETWEEN 1 AND 128),
  event_id TEXT NOT NULL REFERENCES webhook_delivery_events(event_id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key)=64),
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','sending','pending','delivered','dead')),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  replay_token TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  queued_at INTEGER,
  round INTEGER NOT NULL DEFAULT 0 CHECK(round>=0),
  reason TEXT,
  status_code INTEGER,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  expires_at INTEGER NOT NULL CHECK(expires_at>=updated_at),
  PRIMARY KEY(subscription_id,event_id),
  CHECK((state='sending' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'sending' AND lease_token IS NULL AND lease_until IS NULL))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX webhook_delivery_recent ON webhook_delivery_intents(subscription_id,updated_at DESC,event_id);
-- statement-breakpoint
CREATE INDEX webhook_delivery_ready ON webhook_delivery_intents(state,queued_at,created_at,subscription_id,event_id);
-- statement-breakpoint
CREATE INDEX webhook_delivery_recovery ON webhook_delivery_intents(updated_at,subscription_id,event_id)
WHERE state IN ('pending','sending','ready') AND queued_at IS NOT NULL;
-- statement-breakpoint
CREATE INDEX webhook_delivery_expiry ON webhook_delivery_intents(expires_at,subscription_id,event_id);
-- statement-breakpoint
CREATE TRIGGER webhook_delivery_intent_identity BEFORE UPDATE ON webhook_delivery_intents
WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.event_id IS NOT OLD.event_id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.state='delivered' AND (NEW.generation IS NOT OLD.generation OR NEW.replay_token IS NOT OLD.replay_token OR NEW.state IS NOT OLD.state OR NEW.sequence IS NOT OLD.sequence OR NEW.reason IS NOT OLD.reason OR NEW.status_code IS NOT OLD.status_code OR NEW.last_attempt_at IS NOT OLD.last_attempt_at))
BEGIN SELECT RAISE(ABORT,'Webhook delivery identity/success is immutable'); END;
-- statement-breakpoint
CREATE TABLE webhook_delivery_attempts (
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  token TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  round INTEGER NOT NULL CHECK(round>0),
  started_at INTEGER NOT NULL CHECK(started_at>0),
  finished_at INTEGER,
  ambiguous_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'sending' CHECK(outcome IN ('sending','delivered','failed','ambiguous','skipped')),
  reason TEXT,
  status_code INTEGER,
  PRIMARY KEY(subscription_id,event_id,sequence),
  FOREIGN KEY(subscription_id,event_id) REFERENCES webhook_delivery_intents(subscription_id,event_id) ON DELETE CASCADE
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER webhook_delivery_attempt_identity BEFORE UPDATE ON webhook_delivery_attempts
WHEN NEW.subscription_id IS NOT OLD.subscription_id OR NEW.event_id IS NOT OLD.event_id OR NEW.sequence IS NOT OLD.sequence OR NEW.token IS NOT OLD.token OR NEW.target_url IS NOT OLD.target_url OR NEW.generation IS NOT OLD.generation OR NEW.round IS NOT OLD.round OR NEW.started_at IS NOT OLD.started_at
 OR (OLD.outcome IN ('delivered','failed','skipped') AND (NEW.outcome IS NOT OLD.outcome OR NEW.finished_at IS NOT OLD.finished_at OR NEW.reason IS NOT OLD.reason OR NEW.status_code IS NOT OLD.status_code))
BEGIN SELECT RAISE(ABORT,'Webhook attempt identity/outcome is immutable'); END;

-- statement-breakpoint
CREATE INDEX webhook_delivery_success ON webhook_delivery_attempts(subscription_id,event_id,sequence) WHERE outcome='delivered';

-- statement-breakpoint
CREATE INDEX webhook_delivery_event_expiry ON webhook_delivery_events(expires_at,event_id);
-- statement-breakpoint
CREATE INDEX webhook_delivery_intent_event ON webhook_delivery_intents(event_id,subscription_id);
