-- RPC reverse-proxy usage telemetry (B3).
--
-- One row per proxied /rpc/v1/{network} request, written best-effort and async
-- (ctx.waitUntil) by handleRpcProxyRequest so telemetry never adds latency to —
-- or can fail — a proxied call. Powers /api/v1/rpc/usage (request volume,
-- latency p50/p95, failover + error rate, cache-hit rate, and the per-endpoint
-- request distribution that answers "is the load balancer actually balancing").
--
-- Like surface_checks this is a hot time-series, not a long-term store: the
-- hourly cron prunes it to the same 30-day window (pruneHealthHistory) so it
-- stays bounded regardless of proxy traffic. Never retained beyond the window.

CREATE TABLE IF NOT EXISTS rpc_proxy_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at  INTEGER NOT NULL,            -- epoch ms the proxy request started
  network      TEXT    NOT NULL,            -- finney | test (path segment)
  endpoint_id  TEXT,                        -- pool endpoint that served (NULL: cache hit / none eligible)
  provider     TEXT,                        -- served endpoint's provider label
  ok           INTEGER NOT NULL,            -- 1 if the proxy routed to a responding upstream (or cache hit)
  status       INTEGER,                     -- HTTP status returned to the caller
  attempts     INTEGER,                     -- upstream attempts (>1 = failover occurred)
  latency_ms   INTEGER,                     -- end-to-end proxy latency
  cache        TEXT                         -- hit | miss | bypass
);

CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_observed
  ON rpc_proxy_events (observed_at);
CREATE INDEX IF NOT EXISTS idx_rpc_proxy_events_network_observed
  ON rpc_proxy_events (network, observed_at);
