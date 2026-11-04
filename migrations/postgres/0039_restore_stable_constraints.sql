-- Keep catalog identities stable when pg_dump deparses and pg_restore reparses
-- compound CHECK expressions. BETWEEN expands to nested AND, which PostgreSQL
-- flattens on reparse; explicit comparisons start in that stable form.
ALTER TABLE jobs.cron_policy
  DROP CONSTRAINT cron_policy_check,
  ADD CONSTRAINT cron_policy_check CHECK (
    execution_ms >= 1 AND execution_ms <= 3600000 AND execution_ms < lease_ms
  );

ALTER TABLE jobs.cron_schedules
  DROP CONSTRAINT cron_schedules_check,
  ADD CONSTRAINT cron_schedules_check CHECK (
    cursor_ms >= -1 AND cursor_ms <= 9007199254740991
    AND cursor_ms >= start_at_ms - 1
  ),
  DROP CONSTRAINT cron_schedules_check1,
  ADD CONSTRAINT cron_schedules_check1 CHECK (
    pending_at_ms >= 0 AND pending_at_ms <= 9007199254740991
    AND pending_at_ms >= start_at_ms AND pending_at_ms <= cursor_ms
  );

ALTER TABLE realtime.mcp_sessions
  DROP CONSTRAINT mcp_sessions_session_key_check,
  ADD CONSTRAINT mcp_sessions_session_key_check CHECK (
    octet_length(session_key) >= 2 AND octet_length(session_key) <= 1024
    AND json_typeof(session_key::json) = 'string'
  );
