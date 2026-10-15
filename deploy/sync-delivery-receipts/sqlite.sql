-- Qualification schema only. Activation requires an ordered, reviewed migration
-- after held 0039-0043, measured capacity and producer/consumer rollout receipts.
CREATE TABLE sync_delivery_passes (
  lane TEXT COLLATE BINARY NOT NULL,
  captured_at INTEGER NOT NULL,
  expected_rows INTEGER NOT NULL CHECK(expected_rows > 0),
  PRIMARY KEY(lane,captured_at)
);
CREATE TABLE sync_delivery_receipts (
  lane TEXT COLLATE BINARY NOT NULL,
  captured_at INTEGER NOT NULL,
  id TEXT COLLATE BINARY NOT NULL,
  sha256 TEXT COLLATE BINARY NOT NULL,
  parent_id TEXT COLLATE BINARY NOT NULL,
  parent_sha256 TEXT COLLATE BINARY NOT NULL,
  first_key TEXT COLLATE BINARY NOT NULL,
  last_key TEXT COLLATE BINARY NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count > 0),
  PRIMARY KEY(lane,captured_at,id),
  FOREIGN KEY(lane,captured_at) REFERENCES sync_delivery_passes(lane,captured_at),
  CHECK(first_key<=last_key)
);
CREATE INDEX sync_delivery_receipts_ranges ON sync_delivery_receipts(lane,captured_at,first_key,last_key);
CREATE INDEX sync_delivery_receipts_parent ON sync_delivery_receipts(lane,captured_at,parent_id);

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER account_balances_passes_delivery_insert BEFORE INSERT ON account_balances_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='account-balances' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER account_balances_passes_delivery_update BEFORE UPDATE ON account_balances_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='account-balances' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER hotkey_alpha_passes_delivery_insert BEFORE INSERT ON hotkey_alpha_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='hotkey-alpha' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER hotkey_alpha_passes_delivery_update BEFORE UPDATE ON hotkey_alpha_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='hotkey-alpha' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER validator_nominator_counts_passes_delivery_insert BEFORE INSERT ON validator_nominator_counts_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='validator-nominator-counts' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER validator_nominator_counts_passes_delivery_update BEFORE UPDATE ON validator_nominator_counts_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='validator-nominator-counts' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER nominator_positions_passes_delivery_insert BEFORE INSERT ON nominator_positions_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='nominator-positions' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER nominator_positions_passes_delivery_update BEFORE UPDATE ON nominator_positions_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='nominator-positions' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER neurons_passes_delivery_insert BEFORE INSERT ON neurons_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='neurons' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;

-- Legacy writers cannot add unreceipted credit to an identified pass.
CREATE TRIGGER neurons_passes_delivery_update BEFORE UPDATE ON neurons_passes
WHEN EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane='neurons' AND p.captured_at=NEW.captured_at
  AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at)))
BEGIN SELECT RAISE(ABORT,'identified pass cannot accept legacy accounting'); END;
