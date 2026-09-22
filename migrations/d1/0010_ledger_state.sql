-- Ledger captures and delivery evidence (#12173). Shares remain exact decimal TEXT.
CREATE TABLE account_balances(
 ss58 TEXT NOT NULL,
 free_tao REAL NOT NULL,
 reserved_tao REAL NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (ss58)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE account_balances_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 scanned INTEGER,
 outcome TEXT,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_account_balances_passes_completed ON account_balances_passes (completed_at DESC);
-- statement-breakpoint
CREATE TABLE hotkey_alpha(
 hotkey TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 total_alpha REAL NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (hotkey, netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_hotkey_alpha_captured ON hotkey_alpha (captured_at);
-- statement-breakpoint
CREATE INDEX idx_hotkey_alpha_netuid ON hotkey_alpha (netuid, total_alpha DESC);
-- statement-breakpoint
CREATE TABLE hotkey_alpha_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_hotkey_alpha_passes_completed ON hotkey_alpha_passes (completed_at DESC);
-- statement-breakpoint
CREATE TABLE validator_nominator_counts(
 hotkey TEXT NOT NULL,
 nominator_count INTEGER NOT NULL,
 captured_at INTEGER NOT NULL,
 PRIMARY KEY (hotkey)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE validator_nominator_counts_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_validator_nominator_counts_passes_completed ON validator_nominator_counts_passes (completed_at DESC);
-- statement-breakpoint
CREATE TABLE nominator_positions(
 coldkey TEXT NOT NULL,
 hotkey TEXT NOT NULL,
 netuid INTEGER NOT NULL,
 share_fraction REAL,
 captured_at INTEGER NOT NULL,
 shares TEXT,
 source TEXT NOT NULL DEFAULT 'alpha',
 PRIMARY KEY (coldkey, hotkey, netuid)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_nominator_positions_hotkey ON nominator_positions (hotkey, netuid);
-- statement-breakpoint
CREATE INDEX nominator_positions_coldkey_source_captured_idx ON nominator_positions (coldkey, source, captured_at);
-- statement-breakpoint
CREATE TABLE nominator_positions_passes(
 captured_at INTEGER NOT NULL,
 expected_rows INTEGER NOT NULL,
 received_rows INTEGER NOT NULL DEFAULT 0,
 completed_at INTEGER,
 PRIMARY KEY (captured_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_nominator_positions_passes_completed ON nominator_positions_passes (completed_at DESC);
-- statement-breakpoint
CREATE TABLE nominator_scan_receipts(
 captured_at INTEGER NOT NULL,
 coldkey TEXT NOT NULL,
 row_count INTEGER NOT NULL,
 PRIMARY KEY (captured_at, coldkey),
 CHECK ((row_count > 0))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_nominator_positions_capture_pool ON nominator_positions(captured_at, hotkey, netuid);
