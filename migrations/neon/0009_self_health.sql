-- metagraphed's own uptime, measured again (#9836).
--
-- WHAT BROKE, AND WHY IT STAYED BROKEN HONESTLY. `self_health_checks` and
-- `self_health_daily` lived on the indexer box, written by a self-health poller
-- that died with it in #9193. The lakehouse kept a frozen copy of the daily
-- rollup, so /api/v1/self-health still serves 90 days of history -- but its
-- newest day is 2026-08-02 with 482 checks, a day that stopped mid-way.
--
-- The route has been reporting `current_ok: null` and a `degraded` floor ever
-- since, and that was the CORRECT behaviour: null means UNMEASURED, distinct
-- from down, and src/self-health-cold-tier.ts says so at length. Synthesizing a
-- current reading from the last frozen tick would state a probe nobody took,
-- which the probe-derived-only house rule exists to forbid. The endpoint was
-- not lying; it had nothing to say.
--
-- These two tables give the new Worker-cron prober somewhere to say it.
--
-- WHY TWO TABLES rather than deriving the rollup on read. The daily rows are
-- kept for 90 days and the ticks for ~14, so the rollup outlives its own
-- evidence -- exactly as it did on the box. Deriving `days` from `checks` would
-- silently shorten the published history to the tick retention the first time
-- anyone pruned.

-- One row per probe of one component.
CREATE TABLE IF NOT EXISTS self_health_checks (
  component     TEXT   NOT NULL,
  -- Epoch MILLISECONDS. BIGINT, and the reader tolerates it arriving as a
  -- string: this Worker runs postgres.js with `fetch_types: false`, which hands
  -- BIGINT back as TEXT. SelfHealthLatestRow's `number | string` union and its
  -- toMs() coercion exist for precisely that, and typing it as a bare number
  -- would make the newest-tick pick a lexicographic compare.
  checked_at_ms BIGINT NOT NULL,
  ok            BOOLEAN NOT NULL,
  -- Null when the probe never got an HTTP response at all (DNS, TCP, timeout),
  -- which is a different fact from a 5xx and must not be flattened into one.
  http_status   INTEGER,
  latency_ms    INTEGER,
  PRIMARY KEY (component, checked_at_ms)
);

-- The newest tick per component is the "current" reading, so this is the index
-- the serving read actually uses.
CREATE INDEX IF NOT EXISTS idx_self_health_checks_recent
  ON self_health_checks (component, checked_at_ms DESC);

-- The 90-day rollup. `day` is a DATE: the route windows it with `day >= cutoff`
-- against a native date, and the lakehouse tier reproduces that as a
-- lexicographic compare on the zero-padded ISO form, which is only equivalent
-- because the shape is fixed.
CREATE TABLE IF NOT EXISTS self_health_daily (
  day       DATE    NOT NULL,
  component TEXT    NOT NULL,
  checks    INTEGER NOT NULL,
  -- A day with zero ok checks is a real, publishable answer -- we were down.
  -- An ABSENT day means we were not measuring, and the two must never be
  -- confused: /api/v1/self-health omits missing days rather than zero-filling
  -- them for this exact reason.
  ok_count  INTEGER NOT NULL,
  PRIMARY KEY (day, component)
);

CREATE INDEX IF NOT EXISTS idx_self_health_daily_day
  ON self_health_daily (day DESC);
