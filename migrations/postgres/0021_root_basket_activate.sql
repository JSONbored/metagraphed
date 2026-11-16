-- Execute as one transaction after the complete family has been loaded.
-- Block writes while validating imported receipts and attaching enforcement.
LOCK TABLE app.root_basket_captures, app.root_basket_capture_pages,
  app.root_basket_fund_snapshots, app.root_basket_holdings,
  app.root_basket_targets, app.root_basket_capture_completions,
  app.root_basket_current IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION app.root_basket_completion_valid(id text, digest text)
RETURNS boolean LANGUAGE sql VOLATILE
SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.root_basket_captures m
    WHERE m.capture_id = id AND m.content_sha256 = digest
      AND (SELECT count(*) FROM app.root_basket_capture_pages WHERE capture_id = id) = m.expected_pages
      AND (SELECT count(*) FROM app.root_basket_fund_snapshots WHERE capture_id = id) = m.expected_funds
      AND NOT EXISTS (
        SELECT 1 FROM app.root_basket_capture_pages p
        LEFT JOIN app.root_basket_capture_pages previous
          ON previous.capture_id = p.capture_id AND previous.page_index = p.page_index - 1
        WHERE p.capture_id = id AND (
          p.page_index >= m.expected_pages
          OR (p.page_index = m.expected_pages - 1) <> (p.next_after IS NULL)
          OR (p.page_index > 0 AND (previous.page_index IS NULL OR p.start_after IS DISTINCT FROM previous.next_after))
          OR p.fund_count <> (SELECT count(*) FROM app.root_basket_fund_snapshots f
            WHERE f.capture_id = id AND f.page_index = p.page_index)))
      AND NOT EXISTS (
        SELECT 1 FROM app.root_basket_fund_snapshots f
        WHERE f.capture_id = id AND (
          (length(f.first_block), f.first_block) > (length(m.finalized_block), m.finalized_block)
          OR f.holdings_count <> (SELECT count(*) FROM app.root_basket_holdings h
            WHERE h.capture_id = id AND h.hotkey = f.hotkey)
          OR f.targets_count <> (SELECT count(*) FROM app.root_basket_targets t
            WHERE t.capture_id = id AND t.hotkey = f.hotkey)))
  );
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app.root_basket_capture_completions r
    WHERE NOT app.root_basket_completion_valid(r.capture_id, r.content_sha256)) THEN
    RAISE EXCEPTION 'imported root basket completion is inconsistent' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM app.root_basket_current p
    WHERE NOT EXISTS (SELECT 1 FROM app.root_basket_captures c
      WHERE c.capture_id = p.capture_id
        AND c.network_genesis_hash = p.network_genesis_hash AND c.decoder_version = p.decoder_version)) THEN
    RAISE EXCEPTION 'imported root basket current scope is inconsistent' USING ERRCODE = '23514';
  END IF;
END $$;

ALTER TABLE app.root_basket_capture_pages ADD CONSTRAINT root_basket_pages_capture_fk
  FOREIGN KEY (capture_id) REFERENCES app.root_basket_captures (capture_id);
ALTER TABLE app.root_basket_fund_snapshots ADD CONSTRAINT root_basket_funds_page_fk
  FOREIGN KEY (capture_id, page_index) REFERENCES app.root_basket_capture_pages (capture_id, page_index);
ALTER TABLE app.root_basket_holdings ADD CONSTRAINT root_basket_holdings_fund_fk
  FOREIGN KEY (capture_id, hotkey) REFERENCES app.root_basket_fund_snapshots (capture_id, hotkey);
ALTER TABLE app.root_basket_targets ADD CONSTRAINT root_basket_targets_fund_fk
  FOREIGN KEY (capture_id, hotkey) REFERENCES app.root_basket_fund_snapshots (capture_id, hotkey);
ALTER TABLE app.root_basket_capture_completions ADD CONSTRAINT root_basket_completion_capture_fk
  FOREIGN KEY (capture_id) REFERENCES app.root_basket_captures (capture_id);
ALTER TABLE app.root_basket_current ADD CONSTRAINT root_basket_current_completion_fk
  FOREIGN KEY (capture_id) REFERENCES app.root_basket_capture_completions (capture_id);

-- Match the source's serialized writes before acquiring any tuple/FK locks.
-- Read-committed queries inside these volatile triggers see the preceding
-- writer's committed receipt after waiting. A fixed earlier snapshot cannot
-- safely enforce this cross-table invariant, so reject that write mode.
CREATE FUNCTION app.root_basket_lock() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'root basket writes require read committed isolation' USING ERRCODE = '25000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('metagraphed:app:root-basket', 0));
  RETURN NULL;
END;
$$;

CREATE FUNCTION app.root_basket_preserve_completed() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE previous_id text; next_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous_id := OLD.capture_id; END IF;
  IF TG_OP <> 'DELETE' THEN next_id := NEW.capture_id; END IF;
  IF EXISTS (SELECT 1 FROM app.root_basket_capture_completions
    WHERE capture_id IN (previous_id, next_id)) THEN
    RAISE EXCEPTION 'completed root basket observation is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.root_basket_preserve_receipt() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'root_basket_capture_pages' THEN
    RAISE EXCEPTION 'root basket receipt is immutable' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'root basket completion is immutable' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION app.root_basket_check_replay() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.root_basket_captures WHERE capture_id = NEW.capture_id
    AND (network_genesis_hash <> NEW.network_genesis_hash
      OR finalized_block_hash <> NEW.finalized_block_hash OR decoder_version <> NEW.decoder_version)) THEN
    RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: attempt ID already belongs to another observation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM app.root_basket_captures WHERE network_genesis_hash = NEW.network_genesis_hash
    AND decoder_version = NEW.decoder_version AND finalized_block = NEW.finalized_block
    AND finalized_block_hash <> NEW.finalized_block_hash) THEN
    RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: finalized height has a different hash' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM app.root_basket_captures c
    LEFT JOIN app.root_basket_capture_completions r ON r.capture_id = c.capture_id
    WHERE c.network_genesis_hash = NEW.network_genesis_hash
      AND c.finalized_block_hash = NEW.finalized_block_hash AND c.decoder_version = NEW.decoder_version
      AND (r.capture_id IS NULL OR r.content_sha256 <> NEW.content_sha256)) THEN
    RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: observation is incomplete or content differs' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.root_basket_check_completion() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF NOT app.root_basket_completion_valid(NEW.capture_id, NEW.content_sha256) THEN
    RAISE EXCEPTION 'root basket persisted capture is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.root_basket_check_current() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE candidate app.root_basket_captures%ROWTYPE; previous app.root_basket_captures%ROWTYPE;
BEGIN
  SELECT * INTO candidate FROM app.root_basket_captures WHERE capture_id = NEW.capture_id;
  IF NOT FOUND OR candidate.network_genesis_hash <> NEW.network_genesis_hash
    OR candidate.decoder_version <> NEW.decoder_version THEN
    RAISE EXCEPTION 'root basket current scope mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT * INTO previous FROM app.root_basket_captures WHERE capture_id = OLD.capture_id;
    IF NEW.network_genesis_hash <> OLD.network_genesis_hash OR NEW.decoder_version <> OLD.decoder_version
      OR (length(candidate.finalized_block), candidate.finalized_block) < (length(previous.finalized_block), previous.finalized_block)
      OR (NEW.capture_id <> OLD.capture_id AND candidate.finalized_block = previous.finalized_block) THEN
      RAISE EXCEPTION 'root basket current source order cannot regress' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name text; operation text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['root_basket_captures', 'root_basket_capture_pages',
    'root_basket_fund_snapshots', 'root_basket_holdings', 'root_basket_targets',
    'root_basket_capture_completions', 'root_basket_current'] LOOP
    EXECUTE format('CREATE TRIGGER root_basket_write_lock BEFORE INSERT OR UPDATE OR DELETE ON app.%I
      FOR EACH STATEMENT EXECUTE FUNCTION app.root_basket_lock()', table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['root_basket_captures', 'root_basket_capture_pages',
    'root_basket_fund_snapshots', 'root_basket_holdings', 'root_basket_targets'] LOOP
    FOREACH operation IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      -- The source has no immutable-insert trigger on the manifest itself.
      IF table_name = 'root_basket_captures' AND operation = 'INSERT' THEN CONTINUE; END IF;
      EXECUTE format('CREATE TRIGGER %I BEFORE %s ON app.%I
        FOR EACH ROW EXECUTE FUNCTION app.root_basket_preserve_completed()',
        table_name || '_immutable_' || lower(operation), operation, table_name);
    END LOOP;
  END LOOP;
END $$;

CREATE TRIGGER root_basket_receipt_immutable BEFORE UPDATE ON app.root_basket_capture_pages
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_preserve_receipt();
CREATE TRIGGER root_basket_completion_immutable_update BEFORE UPDATE ON app.root_basket_capture_completions
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_preserve_receipt();
CREATE TRIGGER root_basket_completion_immutable_delete BEFORE DELETE ON app.root_basket_capture_completions
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_preserve_receipt();
CREATE TRIGGER root_basket_check_replay BEFORE INSERT ON app.root_basket_captures
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_check_replay();
CREATE TRIGGER root_basket_check_completion BEFORE INSERT ON app.root_basket_capture_completions
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_check_completion();
CREATE TRIGGER root_basket_current_ordered_insert BEFORE INSERT ON app.root_basket_current
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_check_current();
CREATE TRIGGER root_basket_current_ordered_update BEFORE UPDATE ON app.root_basket_current
  FOR EACH ROW EXECUTE FUNCTION app.root_basket_check_current();
