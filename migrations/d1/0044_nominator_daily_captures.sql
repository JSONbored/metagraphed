-- #501: one complete Alpha observation per UTC day. Retain its existing exact
-- staged originals instead of making a second million-member copy. The view's
-- logical key is (coldkey,hotkey,netuid,snapshot_date), proved by the selector
-- day PK and alpha_snapshot_rows capture/member PK; a view has no physical PK.
CREATE TABLE nominator_daily_captures (
  snapshot_date TEXT PRIMARY KEY,
  captured_at INTEGER NOT NULL UNIQUE REFERENCES alpha_snapshot_passes(captured_at),
  CHECK(captured_at>0 AND captured_at<=253402300799999 AND snapshot_date=strftime('%Y-%m-%d',captured_at/1000,'unixepoch'))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_capture_insert BEFORE INSERT ON nominator_daily_captures
WHEN NOT EXISTS (
  SELECT 1 FROM alpha_snapshot_passes p JOIN alpha_runtime_metadata m
  ON m.sha256=p.metadata_sha256 AND m.code_hash=p.code_hash AND m.spec_version=p.spec_version
  WHERE p.captured_at=NEW.captured_at AND p.received_rows=p.expected_rows
  AND p.received_chunks=p.expected_chunks
  AND (SELECT COUNT(*) FROM alpha_snapshot_rows r WHERE r.captured_at=p.captured_at)=p.expected_rows
)
BEGIN SELECT RAISE(ABORT,'Daily Alpha capture census is incomplete'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_capture_update BEFORE UPDATE ON nominator_daily_captures
WHEN NEW.snapshot_date IS NOT OLD.snapshot_date OR NOT EXISTS (
  SELECT 1 FROM alpha_snapshot_passes p JOIN alpha_runtime_metadata m
  ON m.sha256=p.metadata_sha256 AND m.code_hash=p.code_hash AND m.spec_version=p.spec_version
  JOIN alpha_snapshot_passes prior ON prior.captured_at=OLD.captured_at
  WHERE p.captured_at=NEW.captured_at AND p.received_rows=p.expected_rows
  AND p.received_chunks=p.expected_chunks AND p.block_number>prior.block_number
  AND p.captured_at>prior.captured_at
  AND (p.block_number<>prior.block_number OR p.block_hash=prior.block_hash)
  AND (SELECT COUNT(*) FROM alpha_snapshot_rows r WHERE r.captured_at=p.captured_at)=p.expected_rows
)
BEGIN SELECT RAISE(ABORT,'Daily Alpha capture identity or census regressed'); END;
-- statement-breakpoint
CREATE INDEX alpha_snapshot_rows_pool ON alpha_snapshot_rows(captured_at,hotkey,netuid,coldkey);
-- statement-breakpoint
CREATE VIEW nominator_positions_daily AS
SELECT r.coldkey,r.hotkey,r.netuid,d.snapshot_date,r.share_fraction,r.shares,
  r.captured_at,'alpha' AS source,r.alpha_rao,r.alpha_evidence,
  p.block_number,p.block_hash,p.genesis_hash,p.spec_version,p.code_hash,p.metadata_sha256,
  p.completed_at AS updated_at
FROM nominator_daily_captures d JOIN alpha_snapshot_rows r USING(captured_at)
JOIN alpha_snapshot_passes p USING(captured_at)
WHERE p.completed_at IS NOT NULL;
-- statement-breakpoint
-- Old receivers delete ALL completed staging on every packet/retry. Fail their
-- transaction rather than silently erase selected history after a rollback.
CREATE TRIGGER nominator_daily_rows_delete_fence BEFORE DELETE ON alpha_snapshot_rows
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha originals require a compatible receiver'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_rows_update_fence BEFORE UPDATE ON alpha_snapshot_rows
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha originals are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_pools_delete_fence BEFORE DELETE ON alpha_snapshot_pools
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha pools require a compatible receiver'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_pools_update_fence BEFORE UPDATE ON alpha_snapshot_pools
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha pools are immutable'); END;

-- statement-breakpoint
CREATE TRIGGER nominator_daily_rows_insert_fence BEFORE INSERT ON alpha_snapshot_rows
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=NEW.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha originals are immutable'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_capture_delete_fence BEFORE DELETE ON nominator_daily_captures
BEGIN SELECT RAISE(ABORT,'Daily Alpha retention has no approved expiry policy'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_pass_delete_fence BEFORE DELETE ON alpha_snapshot_passes
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
BEGIN SELECT RAISE(ABORT,'Daily Alpha pass identity is retained'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_pass_update_fence BEFORE UPDATE ON alpha_snapshot_passes
WHEN OLD.completed_at IS NOT NULL
AND EXISTS(SELECT 1 FROM nominator_daily_captures d WHERE d.captured_at=OLD.captured_at)
AND (NEW.captured_at IS NOT OLD.captured_at OR NEW.block_number IS NOT OLD.block_number
OR NEW.block_hash IS NOT OLD.block_hash OR NEW.genesis_hash IS NOT OLD.genesis_hash
OR NEW.spec_version IS NOT OLD.spec_version OR NEW.code_hash IS NOT OLD.code_hash
OR NEW.metadata_sha256 IS NOT OLD.metadata_sha256 OR NEW.scanned_legacy IS NOT OLD.scanned_legacy
OR NEW.scanned_v2 IS NOT OLD.scanned_v2 OR NEW.expected_rows IS NOT OLD.expected_rows
OR NEW.received_rows IS NOT OLD.received_rows OR NEW.expected_chunks IS NOT OLD.expected_chunks
OR NEW.received_chunks IS NOT OLD.received_chunks OR NEW.completed_at IS NOT OLD.completed_at
OR NEW.selected IS NOT OLD.selected)
BEGIN SELECT RAISE(ABORT,'Daily Alpha completed pass is immutable'); END;
-- statement-breakpoint
CREATE TRIGGER nominator_daily_metadata_delete_fence BEFORE DELETE ON alpha_runtime_metadata
WHEN EXISTS(SELECT 1 FROM nominator_daily_captures d JOIN alpha_snapshot_passes p USING(captured_at)
  WHERE p.metadata_sha256=OLD.sha256)
BEGIN SELECT RAISE(ABORT,'Daily Alpha runtime original is retained'); END;

-- statement-breakpoint
CREATE TRIGGER nominator_daily_completed_identity BEFORE UPDATE OF completed_at ON alpha_snapshot_passes
WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL
AND EXISTS(SELECT 1 FROM nominator_daily_captures d JOIN alpha_snapshot_passes p USING(captured_at)
  WHERE d.snapshot_date=strftime('%Y-%m-%d',NEW.captured_at/1000,'unixepoch')
  AND p.block_number=NEW.block_number AND p.block_hash<>NEW.block_hash)
BEGIN SELECT RAISE(ABORT,'Daily Alpha capture block identity conflicts'); END;
