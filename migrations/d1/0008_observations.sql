-- Native observations, including stable-key alias displacement (#12169).
CREATE TABLE surface_checks(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 kind TEXT,
 status TEXT,
 classification TEXT,
 latency_ms INTEGER,
 status_code INTEGER,
 ok INTEGER CHECK (ok IN (0,1)),
 checked_at INTEGER NOT NULL,
 PRIMARY KEY(surface_id,checked_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE surface_status(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 kind TEXT,
 url TEXT,
 provider TEXT,
 status TEXT,
 classification TEXT,
 latency_ms INTEGER,
 status_code INTEGER,
 last_checked INTEGER,
 last_ok INTEGER,
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER,
 PRIMARY KEY(surface_id)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE surface_uptime_daily(
 surface_id TEXT NOT NULL,
 surface_key TEXT,
 netuid INTEGER,
 day TEXT NOT NULL,
 samples INTEGER NOT NULL,
 ok_count INTEGER NOT NULL,
 uptime_ratio REAL,
 avg_latency_ms INTEGER,
 status TEXT,
 latency_samples INTEGER,
 p50_latency_ms INTEGER,
 p95_latency_ms INTEGER,
 p99_latency_ms INTEGER,
 updated_at INTEGER,
 PRIMARY KEY(surface_id,day)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE surface_failure_daily(
 day TEXT NOT NULL,
 netuid INTEGER,
 kind TEXT NOT NULL,
 classification TEXT NOT NULL,
 checks INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE TABLE subnet_snapshots(
 netuid INTEGER NOT NULL,
 snapshot_date TEXT NOT NULL,
 completeness_score INTEGER,
 surface_count INTEGER,
 endpoint_count INTEGER,
 monitored_count INTEGER,
 candidate_count INTEGER,
 captured_at INTEGER,
 validator_count INTEGER,
 miner_count INTEGER,
 total_stake_tao REAL,
 alpha_price_tao REAL,
 emission_share REAL,
 tao_in_pool_tao REAL,
 alpha_in_pool REAL,
 alpha_out_pool REAL,
 subnet_volume_tao REAL,
 tao_in_emission_tao REAL,
 excess_tao REAL,
 alpha_in_emission REAL,
 alpha_out_emission REAL,
 miner_burned_fraction REAL,
 emission_enabled INTEGER CHECK (emission_enabled IN (0,1)),
 subtoken_enabled INTEGER CHECK (subtoken_enabled IN (0,1)),
 first_emission_block INTEGER,
 pipeline_block INTEGER,
 pipeline_block_hash TEXT,
 PRIMARY KEY(netuid,snapshot_date)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_surface_checks_netuid_time ON surface_checks(netuid,checked_at DESC);
-- statement-breakpoint
CREATE INDEX idx_surface_checks_time ON surface_checks(checked_at DESC);
-- statement-breakpoint
CREATE UNIQUE INDEX idx_surface_status_key ON surface_status(surface_key) WHERE surface_key IS NOT NULL;
-- statement-breakpoint
CREATE INDEX idx_surface_status_netuid ON surface_status(netuid);
-- statement-breakpoint
CREATE UNIQUE INDEX idx_surface_uptime_key_day ON surface_uptime_daily(surface_key,day) WHERE surface_key IS NOT NULL;
-- statement-breakpoint
CREATE INDEX idx_surface_uptime_netuid_day ON surface_uptime_daily(netuid,day DESC);
-- statement-breakpoint
CREATE UNIQUE INDEX idx_surface_failure_key ON surface_failure_daily(day,COALESCE(netuid,-1),kind,classification);
-- statement-breakpoint
CREATE INDEX idx_surface_failure_day ON surface_failure_daily(day DESC,netuid);
-- statement-breakpoint
CREATE INDEX idx_subnet_snapshots_date_netuid ON subnet_snapshots(snapshot_date,netuid);
-- statement-breakpoint
CREATE TRIGGER surface_status_alias_insert BEFORE INSERT ON surface_status
WHEN NEW.surface_key IS NOT NULL AND NEW.surface_key <> ''
BEGIN
 SELECT RAISE(IGNORE) WHERE EXISTS(SELECT 1 FROM surface_status newer
   WHERE (newer.surface_key=NEW.surface_key OR (newer.surface_id=NEW.surface_id AND newer.surface_key IS NOT NEW.surface_key)) AND newer.last_checked > NEW.last_checked);
 UPDATE surface_status SET surface_id='history:'||surface_key
   WHERE surface_id=NEW.surface_id AND surface_key IS NOT NULL AND surface_key IS NOT NEW.surface_key
     AND COALESCE(last_checked,0)<=NEW.last_checked;
 DELETE FROM surface_status WHERE surface_id=NEW.surface_id AND surface_key IS NULL AND COALESCE(last_checked,0)<=NEW.last_checked;
END;
