-- Explicit post-load phase, run in one transaction while imports/writers are fenced.
-- BY DEFAULT identities accept original source IDs during the load phase.
-- Their next allocation must exceed both imported IDs and any retained legacy
-- sqlite_sequence floor, including IDs belonging to deleted source rows.
LOCK TABLE retained.history_block_sources, retained.history_block_authors,
  source_meta.retained_sqlite_sequence IN ACCESS EXCLUSIVE MODE;

-- Refuse activation before changing either sequence if no next bigint exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT max(id) AS value FROM retained.history_block_sources
      UNION ALL SELECT max(id) FROM retained.history_block_authors
      UNION ALL SELECT max(seq) FROM source_meta.retained_sqlite_sequence
        WHERE name IN ('history_block_sources', 'history_block_authors')
      UNION ALL SELECT last_value FROM pg_sequences WHERE schemaname = 'retained'
        AND sequencename IN ('history_block_sources_id_seq', 'history_block_authors_id_seq')
    ) AS high_water WHERE value >= 9223372036854775807
  ) THEN
    RAISE EXCEPTION 'retained identity has no next bigint value' USING ERRCODE = '22003';
  END IF;
END;
$$;

SELECT setval(
  pg_get_serial_sequence('retained.history_block_sources', 'id'),
  GREATEST(floor, 1),
  floor >= 1
)
FROM (
  SELECT GREATEST(
    COALESCE((SELECT max(id) FROM retained.history_block_sources), 0),
    COALESCE((SELECT max(seq) FROM source_meta.retained_sqlite_sequence
      WHERE name = 'history_block_sources'), 0),
    COALESCE((SELECT last_value FROM pg_sequences
      WHERE schemaname = 'retained' AND sequencename = 'history_block_sources_id_seq'), 0)
  ) AS floor
) AS source_floor;

SELECT setval(
  pg_get_serial_sequence('retained.history_block_authors', 'id'),
  GREATEST(floor, 1),
  floor >= 1
)
FROM (
  SELECT GREATEST(
    COALESCE((SELECT max(id) FROM retained.history_block_authors), 0),
    COALESCE((SELECT max(seq) FROM source_meta.retained_sqlite_sequence
      WHERE name = 'history_block_authors'), 0),
    COALESCE((SELECT last_value FROM pg_sequences
      WHERE schemaname = 'retained' AND sequencename = 'history_block_authors_id_seq'), 0)
  ) AS floor
) AS author_floor;
