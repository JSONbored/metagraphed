-- Preparation only. Registration and every planning/execution tick are explicit
-- runtime calls; this migration installs no schedules, timer or background job.
CREATE SCHEMA IF NOT EXISTS jobs;

CREATE TABLE jobs.cron_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  max_concurrent integer NOT NULL CHECK (max_concurrent BETWEEN 1 AND 100),
  lease_ms integer NOT NULL CHECK (lease_ms BETWEEN 1 AND 3600000),
  execution_ms integer NOT NULL CHECK (execution_ms BETWEEN 1 AND 3600000 AND execution_ms < lease_ms),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  history_limit integer NOT NULL CHECK (history_limit BETWEEN 1 AND 10000)
);

CREATE TABLE jobs.cron_schedules (
  owner text COLLATE "C" NOT NULL CHECK (owner IN ('api','data','registry')),
  cron text COLLATE "C" NOT NULL CHECK (length(cron) BETWEEN 9 AND 128),
  start_at_ms bigint NOT NULL CHECK (start_at_ms BETWEEN 0 AND 9007199254740991),
  cursor_ms bigint NOT NULL CHECK (cursor_ms BETWEEN -1 AND 9007199254740991 AND cursor_ms >= start_at_ms - 1),
  pending_at_ms bigint CHECK (pending_at_ms BETWEEN 0 AND 9007199254740991 AND pending_at_ms >= start_at_ms AND pending_at_ms <= cursor_ms),
  skipped_count bigint NOT NULL DEFAULT 0 CHECK (skipped_count BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (owner,cron)
);

-- Per-planning-window missed slot receipts. Old receipts are explicitly bounded
-- by history_limit; schedules retain their lifetime skipped_count after pruning.
CREATE TABLE jobs.cron_skips (
  owner text COLLATE "C" NOT NULL,
  cron text COLLATE "C" NOT NULL,
  through_ms bigint NOT NULL CHECK (through_ms BETWEEN 0 AND 9007199254740991),
  first_at_ms bigint NOT NULL CHECK (first_at_ms BETWEEN 0 AND through_ms),
  last_at_ms bigint NOT NULL CHECK (last_at_ms BETWEEN first_at_ms AND through_ms),
  slot_count bigint NOT NULL CHECK (slot_count BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (owner,cron,through_ms),
  FOREIGN KEY (owner,cron) REFERENCES jobs.cron_schedules(owner,cron)
);

CREATE TABLE jobs.cron_runs (
  owner text COLLATE "C" NOT NULL,
  cron text COLLATE "C" NOT NULL,
  scheduled_at_ms bigint NOT NULL CHECK (scheduled_at_ms BETWEEN 0 AND 9007199254740991),
  token uuid NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 100),
  started_at_ms bigint NOT NULL CHECK (started_at_ms BETWEEN scheduled_at_ms AND 9007199254740991),
  lease_until_ms bigint NOT NULL CHECK (lease_until_ms BETWEEN started_at_ms AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('running','succeeded','declined','handler-failed','background-failed','aborted','lease-exhausted')),
  finished_at_ms bigint CHECK (finished_at_ms BETWEEN started_at_ms AND 9007199254740991),
  result_ok boolean,
  result_skipped boolean,
  PRIMARY KEY (owner,cron,scheduled_at_ms),
  FOREIGN KEY (owner,cron) REFERENCES jobs.cron_schedules(owner,cron),
  CHECK ((state = 'running') = (finished_at_ms IS NULL))
);
CREATE UNIQUE INDEX cron_one_running ON jobs.cron_runs(owner,cron) WHERE state='running';
CREATE INDEX cron_lease_expiry ON jobs.cron_runs(lease_until_ms) WHERE state='running';
