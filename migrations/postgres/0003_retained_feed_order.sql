-- PostgreSQL indexes do not implicitly append the physical primary key as
-- SQLite WITHOUT ROWID does. Match the native height cursor's complete order.
DROP INDEX retained.history_blocks_height;
CREATE INDEX history_blocks_height ON retained.history_blocks (
  network,
  block_number DESC NULLS LAST,
  observed_at ASC NULLS FIRST,
  source_id DESC,
  ordinal DESC
);
