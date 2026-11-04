-- One explicitly selected membership actor. No process, listener or alarms.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE realtime.subnet_status_actor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_state_bytes integer NOT NULL CHECK (max_state_bytes BETWEEN 1 AND 131072),
  max_memberships integer NOT NULL CHECK (max_memberships BETWEEN 1 AND 10000),
  state text NOT NULL DEFAULT '{}' CHECK (json_typeof(state::json) = 'object'),
  CHECK (octet_length(state) <= max_state_bytes)
);
