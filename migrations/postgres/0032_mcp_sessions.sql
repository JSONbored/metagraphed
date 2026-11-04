-- Resident MCP session custody. No listener, renewal loop or alarm poller starts
-- from this migration; the explicit native service owns those lifetimes.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE realtime.mcp_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_sessions integer NOT NULL CHECK (max_sessions BETWEEN 1 AND 100000),
  max_bytes bigint NOT NULL CHECK (max_bytes BETWEEN 1 AND 1073741824),
  max_state_bytes integer NOT NULL CHECK (max_state_bytes BETWEEN 1 AND 131072),
  session_count integer NOT NULL DEFAULT 0 CHECK (session_count BETWEEN 0 AND max_sessions),
  state_bytes bigint NOT NULL DEFAULT 0 CHECK (state_bytes BETWEEN 0 AND max_bytes)
);
CREATE TABLE realtime.mcp_sessions (
  session_key text COLLATE "C" PRIMARY KEY CHECK (octet_length(session_key) BETWEEN 2 AND 1024 AND json_typeof(session_key::json)='string'),
  state text NOT NULL DEFAULT '{}' CHECK (json_typeof(state::json)='object' AND octet_length(state)<=131072),
  owner_process uuid,
  owner_token uuid,
  lease_until_ms bigint NOT NULL DEFAULT 0 CHECK (lease_until_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  alarm_at_ms bigint CHECK (alarm_at_ms BETWEEN 0 AND 9007199254740991),
  alarm_version bigint NOT NULL DEFAULT 0 CHECK (alarm_version BETWEEN 0 AND 9007199254740991),
  alarm_attempts integer NOT NULL DEFAULT 0 CHECK (alarm_attempts BETWEEN 0 AND 6),
  alarm_run_token uuid,
  alarm_owner_token uuid,
  alarm_run_version bigint CHECK (alarm_run_version BETWEEN 0 AND alarm_version),
  alarm_outcome text NOT NULL DEFAULT 'none' CHECK (alarm_outcome IN ('none','pending','running','completed','retry','exhausted')),
  CHECK ((owner_process IS NULL) = (owner_token IS NULL)),
  CHECK ((alarm_run_token IS NULL) = (alarm_run_version IS NULL)),
  CHECK ((alarm_run_token IS NULL) = (alarm_owner_token IS NULL))
);
CREATE INDEX mcp_alarms_due ON realtime.mcp_sessions(alarm_at_ms,session_key) WHERE alarm_at_ms IS NOT NULL;
CREATE FUNCTION realtime.mcp_state_capacity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog,realtime,pg_temp AS $$
DECLARE delta_count integer; delta_bytes bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.session_key <> OLD.session_key THEN
    RAISE EXCEPTION 'MCP session identity is immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN delta_count:=1; delta_bytes:=octet_length(NEW.state);
  ELSIF TG_OP = 'DELETE' THEN delta_count:=-1; delta_bytes:=-octet_length(OLD.state);
  ELSE delta_count:=0; delta_bytes:=octet_length(NEW.state)-octet_length(OLD.state);
  END IF;
  IF TG_OP <> 'DELETE' AND octet_length(NEW.state) > (SELECT max_state_bytes FROM realtime.mcp_capacity WHERE singleton) THEN
    RAISE EXCEPTION 'MCP session state exceeds configured capacity';
  END IF;
  IF delta_count=0 AND delta_bytes=0 THEN RETURN NULL; END IF;
  UPDATE realtime.mcp_capacity SET session_count=session_count+delta_count,state_bytes=state_bytes+delta_bytes WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'MCP session capacity is not configured'; END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_state_capacity AFTER INSERT OR UPDATE OR DELETE ON realtime.mcp_sessions
FOR EACH ROW EXECUTE FUNCTION realtime.mcp_state_capacity();
