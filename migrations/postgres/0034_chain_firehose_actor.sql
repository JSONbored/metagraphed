-- The native chain owner is prepared explicitly; this migration starts no
-- listener, renewal timer, RPC polling loop or event producer.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE realtime.chain_firehose_actor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_state_bytes integer NOT NULL CHECK (max_state_bytes BETWEEN 1 AND 131072),
  state text NOT NULL DEFAULT '{}' CHECK (json_typeof(state::json) = 'object'),
  owner_token uuid,
  lease_until_ms bigint NOT NULL DEFAULT 0 CHECK (lease_until_ms BETWEEN 0 AND 9007199254740991),
  alarm_at_ms bigint CHECK (alarm_at_ms BETWEEN 0 AND 9007199254740991),
  alarm_version bigint NOT NULL DEFAULT 0 CHECK (alarm_version BETWEEN 0 AND 9007199254740991),
  alarm_attempts integer NOT NULL DEFAULT 0 CHECK (alarm_attempts BETWEEN 0 AND 6),
  alarm_run_token uuid,
  alarm_owner_token uuid,
  alarm_run_version bigint CHECK (alarm_run_version BETWEEN 0 AND alarm_version),
  alarm_outcome text NOT NULL DEFAULT 'none' CHECK (alarm_outcome IN ('none','pending','running','completed','retry','exhausted')),
  CHECK (octet_length(state) <= max_state_bytes),
  CHECK ((alarm_run_token IS NULL) = (alarm_run_version IS NULL)),
  CHECK ((alarm_run_token IS NULL) = (alarm_owner_token IS NULL))
);
