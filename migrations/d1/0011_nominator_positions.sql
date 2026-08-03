-- The nominator-positions family on D1 (#9273), the #9146/#9157 pattern
-- applied to the last frozen account-tier ledger.
--
-- `nominator_positions` was written by a lane on the box. The box is gone, the
-- lakehouse holds the frozen export (153,611 rows, captured 2026-08-02), and
-- NOTHING refreshes it -- so /api/v1/accounts/{ss58}/positions serves a stamp
-- that can never advance, and a coldkey that began delegating after the export
-- gets `positions: 0, total_stake_alpha: 0`: a confident zero, not a decline.
-- This table is where the revived poller lane lands instead; the lakehouse
-- reader (src/nominator-positions-cold-tier.ts) stays as the cold leg for the
-- pre-cutover snapshot.
--
-- Column set is NOT transcribed by hand from deploy/postgres/schema.sql: it is
-- exactly the list the writer binds (NOMINATOR_POSITION_INSERT_COLUMNS,
-- src/account-nominator-positions.ts), and
-- tests/nominator-positions-d1-write.test.ts asserts that correspondence in
-- both directions -- the same anti-drift guarantee as 0007's
-- tests/neurons-d1-schema.test.ts and 0009's own writer check.
--
-- Type translation follows 0007_neurons.sql / 0009_hyperparams_identity.sql:
--   netuid            -> INTEGER
--   share_fraction    -> REAL (dimensionless 0..1 share of a hotkey's
--                        alpha-pool shares on one subnet -- NOT a TAO amount;
--                        see src/account-nominator-positions.ts's header for
--                        why the ledger stores a fraction rather than a
--                        snapshotted stake figure)
--   captured_at       -> INTEGER epoch-ms

-- Latest-only, upserted on (coldkey, hotkey, netuid) with the same
-- `captured_at <= excluded.captured_at` staleness guard every other D1 sync
-- lane uses, and pruned PER COLDKEY rather than batch-wide: a full Alpha scan
-- is posted in several requests (153k rows does not fit one body), so a
-- batch-wide prune would let one request's later capture delete rows a
-- different request just wrote. Per-coldkey is the exact analogue of
-- neurons-sync's per-netuid prune, and it holds for the same reason -- the
-- poster's contract is that a coldkey's positions are never split across two
-- requests.
CREATE TABLE IF NOT EXISTS nominator_positions (
  coldkey        TEXT    NOT NULL,
  hotkey         TEXT    NOT NULL,
  netuid         INTEGER NOT NULL,
  share_fraction REAL    NOT NULL,
  captured_at    INTEGER NOT NULL,
  PRIMARY KEY (coldkey, hotkey, netuid)
);

-- The only read shape: one coldkey's whole position set
-- (src/nominator-positions-hot-tier.ts). The PRIMARY KEY above already leads
-- with `coldkey`, so SQLite serves that lookup from the table's own index --
-- no second index is declared for it. The prune's `coldkey = ? AND
-- captured_at < ?` seek uses the same leading column.

-- The staleness watchdog and the hot-tier reader both ask for the ledger's own
-- capture stamp (MAX(captured_at) over the whole table), which without an
-- index is a full scan of ~153k rows on every zero-position request. This
-- index makes it a single seek to the tail.
CREATE INDEX IF NOT EXISTS idx_nominator_positions_captured_at
  ON nominator_positions (captured_at DESC);
