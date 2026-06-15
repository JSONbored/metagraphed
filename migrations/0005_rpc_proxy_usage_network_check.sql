-- Harden rpc_proxy_events against high-cardinality network labels.
--
-- 0004 originally documented the proxy network as a small enum but did not
-- enforce it. The Worker now rejects unsupported /rpc/v1/{network} paths before
-- recording telemetry; this migration normalizes existing D1 tables to the same
-- invariant and adds a CHECK for future writes.

DELETE FROM rpc_proxy_events
WHERE network NOT IN ('finney');

CREATE TABLE IF NOT EXISTS rpc_proxy_events_hardened (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at  INTEGER NOT NULL,
  network      TEXT    NOT NULL CHECK (network IN ('finney')),
  endpoint_id  TEXT,
  provider     TEXT,
  ok           INTEGER NOT NULL,
  status       INTEGER,
  attempts     INTEGER,
  latency_ms   INTEGER,
  cache        TEXT
);

INSERT INTO rpc_proxy_events_hardened (
  id,
  observed_at,
  network,
  endpoint_id,
  provider,
  ok,
  status,
  attempts,
  latency_ms,
  cache
)
SELECT
  id,
  observed_at,
  network,
  endpoint_id,
  provider,
  ok,
  status,
  attempts,
  latency_ms,
  cache
FROM rpc_proxy_events;

DROP TABLE rpc_proxy_events;
ALTER TABLE rpc_proxy_events_hardened RENAME TO rpc_proxy_events;

CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_observed
  ON rpc_proxy_events (observed_at);
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_network_observed
  ON rpc_proxy_events (network, observed_at);
