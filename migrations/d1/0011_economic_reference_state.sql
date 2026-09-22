-- Economic reference rows retained for the shared D1 readers (#12175).
CREATE TABLE tao_usd_index(
 block_number INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 usd_per_tao REAL,
 price_basis TEXT NOT NULL,
 eth_usd REAL,
 pool_count INTEGER NOT NULL,
 pools TEXT NOT NULL DEFAULT '[]',
 CHECK ((((price_basis = 'insufficient_pools') AND (usd_per_tao IS NULL)) OR ((price_basis <> 'insufficient_pools') AND (usd_per_tao IS NOT NULL)))),
 PRIMARY KEY (block_number, observed_at),
 CHECK ((pool_count >= 0)),
 CHECK ((price_basis IN ('wrapped_onchain_median', 'insufficient_pools')))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_tao_usd_index_observed ON tao_usd_index (observed_at DESC);
-- statement-breakpoint
CREATE TABLE treasury_readings(
 netuid INTEGER NOT NULL,
 source_url TEXT NOT NULL,
 read_at_sha TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 first_seen INTEGER NOT NULL,
 found INTEGER NOT NULL CHECK (found IN (0,1)),
 declared_share REAL,
 treasury_address TEXT,
 applies_to TEXT,
 evidence_path TEXT,
 review_state TEXT NOT NULL DEFAULT 'candidate',
 reviewed_at INTEGER,
 CHECK (((found = false) OR (declared_share IS NOT NULL) OR (treasury_address IS NOT NULL))),
 CHECK ((first_seen >= 1000000000000)),
 CHECK (((found = true) OR ((declared_share IS NULL) AND (treasury_address IS NULL)))),
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (netuid, source_url),
 CHECK ((review_state IN ('candidate', 'reviewed', 'rejected'))),
 CHECK (((declared_share IS NULL) OR ((declared_share >= (0)) AND (declared_share <= (1)))))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_treasury_readings_netuid_state ON treasury_readings (netuid, review_state);
-- statement-breakpoint
CREATE TABLE chain_concentration_daily(
 day TEXT NOT NULL,
 neuron_count INTEGER NOT NULL,
 card TEXT NOT NULL,
 source_captured_at INTEGER,
 computed_at INTEGER NOT NULL,
 builder_version INTEGER NOT NULL,
 PRIMARY KEY (day)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_chain_concentration_daily_day ON chain_concentration_daily (day DESC);
-- statement-breakpoint
CREATE TABLE revenue_observations(
 surface_id TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 period TEXT NOT NULL,
 grain TEXT NOT NULL,
 amount REAL NOT NULL,
 currency TEXT NOT NULL,
 provenance TEXT NOT NULL,
 response_hash TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (surface_id, period),
 CHECK ((provenance IN ('probe-derived', 'chain-verified')))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_revenue_obs_netuid_period ON revenue_observations (netuid, period DESC);
-- statement-breakpoint
CREATE INDEX idx_revenue_obs_period ON revenue_observations (period DESC);
-- statement-breakpoint
CREATE TABLE revenue_probe_failures(
 surface_id TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 reason TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 CHECK ((observed_at >= 1000000000000)),
 PRIMARY KEY (surface_id, observed_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_revenue_failures_netuid ON revenue_probe_failures (netuid, observed_at DESC);
