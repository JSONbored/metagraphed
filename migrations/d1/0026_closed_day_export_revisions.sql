-- Closed-day exports ignore live-day traffic but detect corrections and retention.
-- Track both document contents and member projections; open-day writes add no revision work.
-- statement-breakpoint
CREATE TRIGGER neuron_daily_documents_closed_day_insert AFTER INSERT ON neuron_daily_documents
WHEN NEW.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || NEW.day,1 WHERE NEW.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_documents_closed_day_delete AFTER DELETE ON neuron_daily_documents
WHEN OLD.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || OLD.day,1 WHERE OLD.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_documents_closed_day_update AFTER UPDATE ON neuron_daily_documents
WHEN OLD.day < date('now') OR NEW.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || OLD.day,1 WHERE OLD.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || NEW.day,1 WHERE NEW.day < date('now') AND NEW.day <> OLD.day
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_members_closed_day_insert AFTER INSERT ON neuron_daily_members
WHEN NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_members_closed_day_delete AFTER DELETE ON neuron_daily_members
WHEN OLD.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER neuron_daily_members_closed_day_update AFTER UPDATE ON neuron_daily_members
WHEN OLD.snapshot_date < date('now') OR NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'neuron_daily/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now') AND NEW.snapshot_date <> OLD.snapshot_date
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_documents_closed_day_insert AFTER INSERT ON account_position_daily_documents
WHEN NEW.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || NEW.day,1 WHERE NEW.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_documents_closed_day_delete AFTER DELETE ON account_position_daily_documents
WHEN OLD.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || OLD.day,1 WHERE OLD.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_documents_closed_day_update AFTER UPDATE ON account_position_daily_documents
WHEN OLD.day < date('now') OR NEW.day < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || OLD.day,1 WHERE OLD.day < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || NEW.day,1 WHERE NEW.day < date('now') AND NEW.day <> OLD.day
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_members_closed_day_insert AFTER INSERT ON account_position_daily_members
WHEN NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_members_closed_day_delete AFTER DELETE ON account_position_daily_members
WHEN OLD.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER account_position_daily_members_closed_day_update AFTER UPDATE ON account_position_daily_members
WHEN OLD.snapshot_date < date('now') OR NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'account_position_daily/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now') AND NEW.snapshot_date <> OLD.snapshot_date
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER subnet_snapshots_closed_day_insert AFTER INSERT ON subnet_snapshots
WHEN NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'subnet_snapshots/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER subnet_snapshots_closed_day_delete AFTER DELETE ON subnet_snapshots
WHEN OLD.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'subnet_snapshots/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
CREATE TRIGGER subnet_snapshots_closed_day_update AFTER UPDATE ON subnet_snapshots
WHEN OLD.snapshot_date < date('now') OR NEW.snapshot_date < date('now') BEGIN
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'subnet_snapshots/' || OLD.snapshot_date,1 WHERE OLD.snapshot_date < date('now')
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
  INSERT INTO archive_export_revisions(table_name,revision)
  SELECT 'subnet_snapshots/' || NEW.snapshot_date,1 WHERE NEW.snapshot_date < date('now') AND NEW.snapshot_date <> OLD.snapshot_date
  ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1;
END;
-- statement-breakpoint
INSERT INTO archive_export_revisions(table_name,revision) VALUES('__closed_day_revisions_v1',1);
