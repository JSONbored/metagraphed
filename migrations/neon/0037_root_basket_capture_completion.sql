-- Completion is verified in the same transaction as all observation writes.
-- No reader or scheduled producer is enabled by this migration.
CREATE TABLE IF NOT EXISTS root_basket_capture_completions (
  capture_id UUID PRIMARY KEY REFERENCES root_basket_captures (capture_id),
  content_sha256 root_basket_hash32 NOT NULL,
  accepted_at_ms root_basket_u64 NOT NULL
);

CREATE TABLE IF NOT EXISTS root_basket_current (
  network_genesis_hash root_basket_hash32 NOT NULL,
  decoder_version TEXT NOT NULL,
  capture_id UUID NOT NULL REFERENCES root_basket_capture_completions (capture_id),
  PRIMARY KEY (network_genesis_hash, decoder_version)
);

CREATE OR REPLACE FUNCTION root_basket_preserve_completion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'root basket completion is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS root_basket_completion_immutable ON root_basket_capture_completions;
CREATE TRIGGER root_basket_completion_immutable
  BEFORE UPDATE OR DELETE ON root_basket_capture_completions
  FOR EACH ROW EXECUTE FUNCTION root_basket_preserve_completion();

CREATE OR REPLACE FUNCTION root_basket_preserve_completed_observation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE id UUID; next_id UUID;
BEGIN
  id := CASE WHEN TG_OP = 'INSERT' THEN NEW.capture_id ELSE OLD.capture_id END;
  next_id := CASE WHEN TG_OP = 'UPDATE' THEN NEW.capture_id ELSE id END;
  -- Row mutation already locks a manifest itself. Child writes must take the
  -- same parent lock as completion BEFORE checking the receipt, including both
  -- parents in deterministic order when moving a child between captures.
  IF TG_TABLE_NAME <> 'root_basket_captures' THEN
    PERFORM capture_id FROM root_basket_captures
      WHERE capture_id IN (id, next_id) ORDER BY capture_id FOR UPDATE;
  END IF;
  IF EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id IN (id, next_id)) THEN
    RAISE EXCEPTION 'completed root basket observation is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['root_basket_captures', 'root_basket_capture_pages',
    'root_basket_fund_snapshots', 'root_basket_holdings', 'root_basket_targets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS root_basket_completed_immutable ON %I', table_name);
    EXECUTE format('CREATE TRIGGER root_basket_completed_immutable BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION root_basket_preserve_completed_observation()', table_name);
  END LOOP;
END;
$$;

-- Serialize captures within one source/decoder scope. An identical observation
-- can arrive under another attempt ID; retain the first accepted provenance.
CREATE OR REPLACE FUNCTION root_basket_check_replay(payload JSONB, digest root_basket_hash32)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE existing root_basket_captures%ROWTYPE; receipt root_basket_capture_completions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    (payload->>'network_genesis_hash') || ':' || (payload->>'decoder_version'), 0));
  IF EXISTS (SELECT 1 FROM root_basket_captures
    WHERE capture_id = (payload->>'capture_id')::uuid
      AND (network_genesis_hash <> payload->>'network_genesis_hash'
        OR finalized_block_hash <> payload->>'finalized_block_hash'
        OR decoder_version <> payload->>'decoder_version')) THEN
    RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: attempt ID already belongs to another observation';
  END IF;
  IF EXISTS (SELECT 1 FROM root_basket_captures
    WHERE network_genesis_hash = payload->>'network_genesis_hash'
      AND decoder_version = payload->>'decoder_version'
      AND finalized_block = (payload->>'finalized_block')::numeric
      AND finalized_block_hash <> payload->>'finalized_block_hash') THEN
    RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: finalized height has a different hash';
  END IF;
  SELECT * INTO existing FROM root_basket_captures
    WHERE network_genesis_hash = payload->>'network_genesis_hash'
      AND finalized_block_hash = payload->>'finalized_block_hash'
      AND decoder_version = payload->>'decoder_version';
  IF FOUND THEN
    SELECT * INTO receipt FROM root_basket_capture_completions WHERE capture_id = existing.capture_id;
    IF NOT FOUND OR receipt.content_sha256 <> digest THEN
      RAISE EXCEPTION 'ROOT_BASKET_CAPTURE_CONFLICT: observation is incomplete or content differs';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION root_basket_check_current() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE candidate root_basket_captures%ROWTYPE; previous_height NUMERIC;
BEGIN
  SELECT * INTO STRICT candidate FROM root_basket_captures WHERE capture_id = NEW.capture_id;
  IF candidate.network_genesis_hash <> NEW.network_genesis_hash OR candidate.decoder_version <> NEW.decoder_version THEN
    RAISE EXCEPTION 'root basket current scope mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT finalized_block INTO STRICT previous_height FROM root_basket_captures WHERE capture_id = OLD.capture_id;
    IF NEW.network_genesis_hash <> OLD.network_genesis_hash OR NEW.decoder_version <> OLD.decoder_version
      OR candidate.finalized_block < previous_height
      OR (candidate.finalized_block = previous_height AND NEW.capture_id <> OLD.capture_id) THEN
      RAISE EXCEPTION 'root basket current source order cannot regress' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS root_basket_current_ordered ON root_basket_current;
CREATE TRIGGER root_basket_current_ordered BEFORE INSERT OR UPDATE ON root_basket_current
  FOR EACH ROW EXECUTE FUNCTION root_basket_check_current();

CREATE OR REPLACE FUNCTION root_basket_complete_capture(id UUID, digest root_basket_hash32, accepted root_basket_u64)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE manifest root_basket_captures%ROWTYPE;
BEGIN
  SELECT * INTO STRICT manifest FROM root_basket_captures WHERE capture_id = id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM root_basket_capture_completions WHERE capture_id = id AND content_sha256 = digest) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM root_basket_capture_pages WHERE capture_id = id) <> manifest.expected_pages
    OR (SELECT count(*) FROM root_basket_fund_snapshots WHERE capture_id = id) <> manifest.expected_funds
    OR EXISTS (SELECT 1 FROM root_basket_capture_pages p
      LEFT JOIN root_basket_capture_pages previous ON previous.capture_id = p.capture_id AND previous.page_index = p.page_index - 1
      WHERE p.capture_id = id AND (p.page_index >= manifest.expected_pages
        OR (p.page_index = manifest.expected_pages - 1) <> (p.next_after IS NULL)
        OR (p.page_index > 0 AND (previous.page_index IS NULL OR p.start_after IS DISTINCT FROM previous.next_after))
        OR p.fund_count <> (SELECT count(*) FROM root_basket_fund_snapshots f WHERE f.capture_id = id AND f.page_index = p.page_index)))
    OR EXISTS (SELECT 1 FROM root_basket_fund_snapshots f WHERE f.capture_id = id AND (
      f.first_block > manifest.finalized_block
      OR f.holdings_count <> (SELECT count(*) FROM root_basket_holdings h WHERE h.capture_id = id AND h.hotkey = f.hotkey)
      OR f.targets_count <> (SELECT count(*) FROM root_basket_targets t WHERE t.capture_id = id AND t.hotkey = f.hotkey))) THEN
    RAISE EXCEPTION 'root basket persisted capture is incomplete' USING ERRCODE = '23514';
  END IF;
  INSERT INTO root_basket_capture_completions VALUES (id, digest, accepted);
  INSERT INTO root_basket_current VALUES (manifest.network_genesis_hash, manifest.decoder_version, id)
    ON CONFLICT (network_genesis_hash, decoder_version) DO UPDATE SET capture_id = EXCLUDED.capture_id
    WHERE (SELECT finalized_block FROM root_basket_captures WHERE capture_id = root_basket_current.capture_id) < manifest.finalized_block;
END;
$$;
