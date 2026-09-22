-- Retained subnet and identity capture state (#12171).
-- Unbounded chain integers remain decimal TEXT; clocks and IDs are safe integers.
CREATE TABLE subnet_hyperparams(
 netuid INTEGER NOT NULL,
 kappa_ratio REAL,
 immunity_period INTEGER,
 min_allowed_weights INTEGER,
 max_weight_limit_ratio REAL,
 tempo INTEGER,
 weights_version TEXT,
 weights_rate_limit REAL,
 activity_cutoff INTEGER,
 activity_cutoff_factor INTEGER,
 registration_allowed INTEGER CHECK (registration_allowed IN (0,1)),
 target_regs_per_interval INTEGER,
 min_burn_tao REAL,
 max_burn_tao REAL,
 burn_half_life INTEGER,
 burn_increase_mult REAL,
 bonds_moving_avg_raw TEXT,
 max_regs_per_block INTEGER,
 serving_rate_limit INTEGER,
 max_validators INTEGER,
 commit_reveal_period INTEGER,
 commit_reveal_enabled INTEGER CHECK (commit_reveal_enabled IN (0,1)),
 alpha_high_ratio REAL,
 alpha_low_ratio REAL,
 liquid_alpha_enabled INTEGER CHECK (liquid_alpha_enabled IN (0,1)),
 alpha_sigmoid_steepness REAL,
 yuma_version INTEGER,
 subnet_is_active INTEGER CHECK (subnet_is_active IN (0,1)),
 transfers_enabled INTEGER CHECK (transfers_enabled IN (0,1)),
 bonds_reset_enabled INTEGER CHECK (bonds_reset_enabled IN (0,1)),
 user_liquidity_enabled INTEGER CHECK (user_liquidity_enabled IN (0,1)),
 owner_cut_enabled INTEGER CHECK (owner_cut_enabled IN (0,1)),
 owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0,1)),
 min_childkey_take_ratio REAL,
 block_number INTEGER,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE subnet_hyperparams_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 block_number INTEGER,
 observed_at INTEGER NOT NULL,
 kappa_ratio REAL,
 immunity_period INTEGER,
 min_allowed_weights INTEGER,
 max_weight_limit_ratio REAL,
 tempo INTEGER,
 weights_version TEXT,
 weights_rate_limit REAL,
 activity_cutoff INTEGER,
 activity_cutoff_factor INTEGER,
 registration_allowed INTEGER CHECK (registration_allowed IN (0,1)),
 target_regs_per_interval INTEGER,
 min_burn_tao REAL,
 max_burn_tao REAL,
 burn_half_life INTEGER,
 burn_increase_mult REAL,
 bonds_moving_avg_raw TEXT,
 max_regs_per_block INTEGER,
 serving_rate_limit INTEGER,
 max_validators INTEGER,
 commit_reveal_period INTEGER,
 commit_reveal_enabled INTEGER CHECK (commit_reveal_enabled IN (0,1)),
 alpha_high_ratio REAL,
 alpha_low_ratio REAL,
 liquid_alpha_enabled INTEGER CHECK (liquid_alpha_enabled IN (0,1)),
 alpha_sigmoid_steepness REAL,
 yuma_version INTEGER,
 subnet_is_active INTEGER CHECK (subnet_is_active IN (0,1)),
 transfers_enabled INTEGER CHECK (transfers_enabled IN (0,1)),
 bonds_reset_enabled INTEGER CHECK (bonds_reset_enabled IN (0,1)),
 user_liquidity_enabled INTEGER CHECK (user_liquidity_enabled IN (0,1)),
 owner_cut_enabled INTEGER CHECK (owner_cut_enabled IN (0,1)),
 owner_cut_auto_lock_enabled INTEGER CHECK (owner_cut_auto_lock_enabled IN (0,1)),
 min_childkey_take_ratio REAL,
 hyperparams_hash TEXT NOT NULL,
 UNIQUE (netuid, observed_at)
);
-- statement-breakpoint
CREATE INDEX idx_subnet_hyperparams_history_netuid_observed ON subnet_hyperparams_history (netuid, observed_at DESC, id DESC);
-- statement-breakpoint
CREATE TABLE account_identity(
 account TEXT NOT NULL,
 name TEXT,
 url TEXT,
 github TEXT,
 image TEXT,
 discord TEXT,
 description TEXT,
 additional TEXT,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (account)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE account_identity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 name TEXT,
 url TEXT,
 github TEXT,
 image TEXT,
 discord TEXT,
 description TEXT,
 additional TEXT,
 identity_hash TEXT NOT NULL,
 UNIQUE (account, observed_at)
);
-- statement-breakpoint
CREATE INDEX idx_account_identity_history_account_observed ON account_identity_history (account, observed_at DESC, id DESC);
-- statement-breakpoint
CREATE TABLE subnet_identity(
 netuid INTEGER NOT NULL,
 block_number INTEGER NOT NULL,
 captured_at INTEGER NOT NULL,
 subnet_name TEXT,
 symbol TEXT,
 description TEXT,
 github_repo TEXT,
 subnet_url TEXT,
 discord TEXT,
 logo_url TEXT,
 identity_hash TEXT,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX subnet_identity_captured_at_idx ON subnet_identity (captured_at DESC);
-- statement-breakpoint
CREATE TABLE subnet_identity_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 block_number INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 subnet_name TEXT,
 symbol TEXT,
 description TEXT,
 github_repo TEXT,
 subnet_url TEXT,
 discord TEXT,
 logo_url TEXT,
 identity_hash TEXT NOT NULL
);
-- statement-breakpoint
CREATE UNIQUE INDEX subnet_identity_history_netuid_hash_idx ON subnet_identity_history (netuid, identity_hash);
-- statement-breakpoint
CREATE INDEX subnet_identity_history_netuid_observed_idx ON subnet_identity_history (netuid, observed_at DESC, id DESC);
-- statement-breakpoint
CREATE INDEX subnet_identity_history_observed_idx ON subnet_identity_history (observed_at DESC, id DESC);
-- statement-breakpoint
CREATE TABLE subnet_ownership(
 netuid INTEGER NOT NULL,
 owner_hotkey TEXT NOT NULL,
 owner_coldkey TEXT NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX subnet_ownership_captured_at_idx ON subnet_ownership (captured_at DESC);
-- statement-breakpoint
CREATE TABLE subnet_ownership_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 owner_hotkey TEXT NOT NULL,
 owner_coldkey TEXT NOT NULL,
 captured_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX subnet_ownership_history_netuid_captured_at_idx ON subnet_ownership_history (netuid, captured_at);
-- statement-breakpoint
CREATE UNIQUE INDEX subnet_ownership_history_netuid_owner_idx ON subnet_ownership_history (netuid, owner_hotkey, owner_coldkey);
-- statement-breakpoint
CREATE TABLE subnet_burn_history(
 netuid INTEGER NOT NULL,
 observed_at INTEGER NOT NULL,
 burn_tao REAL NOT NULL,
 PRIMARY KEY (netuid, observed_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_subnet_burn_history_observed ON subnet_burn_history (observed_at);
-- statement-breakpoint
CREATE TABLE subnet_lifecycle(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 netuid INTEGER NOT NULL,
 event TEXT NOT NULL,
 block_number INTEGER,
 observed_at INTEGER NOT NULL,
 predates_capture INTEGER NOT NULL DEFAULT 0 CHECK (predates_capture IN (0,1)),
 CHECK(event IN ('registered','deregistered')),
 CHECK(observed_at>=1000000000000)
);
-- statement-breakpoint
CREATE INDEX idx_subnet_lifecycle_netuid_time ON subnet_lifecycle (netuid, observed_at DESC);
-- statement-breakpoint
CREATE INDEX idx_subnet_lifecycle_time ON subnet_lifecycle (observed_at DESC);
