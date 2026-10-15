-- Qualification schema only; not a migration or deployment instruction.
CREATE TABLE sync_delivery_passes (
  lane TEXT COLLATE "C" NOT NULL,
  captured_at BIGINT NOT NULL,
  expected_rows INTEGER NOT NULL CHECK(expected_rows > 0),
  PRIMARY KEY(lane,captured_at)
);
CREATE TABLE sync_delivery_receipts (
  lane TEXT COLLATE "C" NOT NULL,
  captured_at BIGINT NOT NULL,
  id TEXT COLLATE "C" NOT NULL,
  sha256 TEXT COLLATE "C" NOT NULL,
  parent_id TEXT COLLATE "C" NOT NULL,
  parent_sha256 TEXT COLLATE "C" NOT NULL,
  first_key TEXT COLLATE "C" NOT NULL,
  last_key TEXT COLLATE "C" NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count > 0),
  PRIMARY KEY(lane,captured_at,id),
  FOREIGN KEY(lane,captured_at) REFERENCES sync_delivery_passes(lane,captured_at),
  CHECK(first_key<=last_key)
);
CREATE INDEX sync_delivery_receipts_ranges ON sync_delivery_receipts(lane,captured_at,first_key,last_key);
CREATE INDEX sync_delivery_receipts_parent ON sync_delivery_receipts(lane,captured_at,parent_id);

CREATE FUNCTION reject_unreceipted_sync_tally() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sync_delivery_passes p WHERE p.lane=TG_ARGV[0] AND p.captured_at=NEW.captured_at
    AND (p.expected_rows<>NEW.expected_rows OR NEW.received_rows<>(SELECT COALESCE(SUM(r.row_count),0) FROM sync_delivery_receipts r WHERE r.lane=p.lane AND r.captured_at=p.captured_at))) THEN
    RAISE EXCEPTION 'identified pass cannot accept legacy accounting';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER account_balances_passes_delivery BEFORE INSERT OR UPDATE ON account_balances_passes FOR EACH ROW EXECUTE FUNCTION reject_unreceipted_sync_tally('account-balances');
CREATE TRIGGER hotkey_alpha_passes_delivery BEFORE INSERT OR UPDATE ON hotkey_alpha_passes FOR EACH ROW EXECUTE FUNCTION reject_unreceipted_sync_tally('hotkey-alpha');
CREATE TRIGGER validator_nominator_counts_passes_delivery BEFORE INSERT OR UPDATE ON validator_nominator_counts_passes FOR EACH ROW EXECUTE FUNCTION reject_unreceipted_sync_tally('validator-nominator-counts');
CREATE TRIGGER nominator_positions_passes_delivery BEFORE INSERT OR UPDATE ON nominator_positions_passes FOR EACH ROW EXECUTE FUNCTION reject_unreceipted_sync_tally('nominator-positions');
CREATE TRIGGER neurons_passes_delivery BEFORE INSERT OR UPDATE ON neurons_passes FOR EACH ROW EXECUTE FUNCTION reject_unreceipted_sync_tally('neurons');
