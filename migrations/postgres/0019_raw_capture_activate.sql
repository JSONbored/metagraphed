-- Run transactionally while external raw-capture writers remain fenced.
LOCK TABLE app.raw_capture_budget, app.raw_capture_batches, app.raw_capture_chunks,
    app.raw_capture_selected, app.raw_capture_archives, app.raw_capture_publications,
    app.raw_capture_state IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF (SELECT count(*) FROM app.raw_capture_budget) <> 1 OR NOT EXISTS (
        SELECT 1 FROM app.raw_capture_budget
        WHERE id = 1 AND bytes = (SELECT COALESCE(sum(compressed_bytes), 0) FROM app.raw_capture_batches)
            AND objects = (SELECT count(*) FROM app.raw_capture_batches)
    ) THEN
        RAISE EXCEPTION 'Raw capture budget differs from retained batches' USING ERRCODE = '23514';
    END IF;
END;
$$;
ALTER TABLE app.raw_capture_chunks ADD CONSTRAINT raw_capture_chunks_batch_fkey
    FOREIGN KEY (key, sha256) REFERENCES app.raw_capture_batches(key, sha256) ON DELETE CASCADE;
ALTER TABLE app.raw_capture_selected ADD CONSTRAINT raw_capture_selected_batch_fkey
    FOREIGN KEY (key, sha256) REFERENCES app.raw_capture_batches(key, sha256);

CREATE TRIGGER raw_capture_lock BEFORE INSERT OR UPDATE OR DELETE ON app.raw_capture_budget
    FOR EACH STATEMENT EXECUTE FUNCTION app.raw_capture_lock();
CREATE TRIGGER raw_capture_lock BEFORE INSERT OR UPDATE OR DELETE ON app.raw_capture_batches
    FOR EACH STATEMENT EXECUTE FUNCTION app.raw_capture_lock();
CREATE TRIGGER raw_capture_lock BEFORE INSERT OR UPDATE OR DELETE ON app.raw_capture_chunks
    FOR EACH STATEMENT EXECUTE FUNCTION app.raw_capture_lock();
CREATE TRIGGER raw_capture_lock BEFORE INSERT OR UPDATE OR DELETE ON app.raw_capture_selected
    FOR EACH STATEMENT EXECUTE FUNCTION app.raw_capture_lock();
CREATE TRIGGER raw_capture_lock BEFORE INSERT OR UPDATE OR DELETE ON app.raw_capture_archives
    FOR EACH STATEMENT EXECUTE FUNCTION app.raw_capture_lock();
CREATE TRIGGER raw_capture_reserve AFTER INSERT ON app.raw_capture_batches
    FOR EACH ROW EXECUTE FUNCTION app.raw_capture_reserve();
CREATE TRIGGER raw_capture_release AFTER DELETE ON app.raw_capture_batches
    FOR EACH ROW EXECUTE FUNCTION app.raw_capture_release();
CREATE TRIGGER raw_capture_archive_source BEFORE INSERT ON app.raw_capture_archives
    FOR EACH ROW EXECUTE FUNCTION app.raw_capture_archive_source();
CREATE TRIGGER raw_capture_archive_release AFTER INSERT ON app.raw_capture_archives
    FOR EACH ROW EXECUTE FUNCTION app.raw_capture_archive_release();
