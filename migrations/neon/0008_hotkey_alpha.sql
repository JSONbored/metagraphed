-- hotkey_alpha: the table #10139 made sole-store and no migration creates (#10145).
--
-- 0007 transcribed six hand-created tables for exactly this reason, and this is
-- the seventh -- missed there by SCOPE, not by oversight. That sweep asked
-- "which SOLE-STORE table has no migration", and on the day it ran hotkey_alpha
-- was still dual-written, so D1's 0019_hotkey_alpha.sql was still a usable
-- record of its shape. #10139 flipped it to sole-store the next day and the
-- record stopped being usable, without anything changing about this table.
--
-- The rows are fine. hotkey_alpha holds 17,837 rows in Neon and was verified
-- row-for-row against D1 before the flip (identical rows, identical max, same
-- newest-pass count, SUM(total_alpha) matching to the cent). What is missing is
-- only the repo's ability to RECREATE the table -- on a new Neon branch, a
-- restore, or a fresh environment. Deleting D1 removes the last copy of that
-- knowledge.
--
-- IF NOT EXISTS, so this is a no-op against the live table and a record for
-- everything downstream of it. It changes nothing in production by design.
--
-- ON THE TYPES, and how they are known without reading information_schema.
-- Unlike 0007 these were not read back off the live database. They are the
-- types the WRITER already declares and production already accepts:
-- src/ledger-neon-write.ts's hotkey-alpha plan carries
--
--   columnTypes: { netuid: "int", total_alpha: "double precision",
--                  captured_at: "bigint" }
--
-- and those casts exist because the filtered VALUES form resolves every
-- parameter to TEXT, which Postgres rejected against these columns. A cast that
-- is load-bearing in production is direct evidence of the column type it casts
-- to -- if `netuid` were TEXT the cast would be unnecessary, and if it were
-- BIGINT the `int` cast would still be wrong to write here. `hotkey` takes no
-- cast because it is TEXT on both sides.
--
-- Same three translations from D1 that 0007 documents:
--
--   INTEGER (netuid)      ->  INTEGER           a subnet id, not an epoch
--   REAL                  ->  DOUBLE PRECISION
--   INTEGER (epoch ms)    ->  BIGINT            captured_at
--
-- WHY total_alpha IS NOT NULL, carried over from 0019: a genuine zero is a real
-- pool size, so a missing read must be an ABSENT ROW rather than a zero one.
-- The distinction is the whole reason #9414 exists.
CREATE TABLE IF NOT EXISTS hotkey_alpha (
  hotkey      TEXT             NOT NULL,
  netuid      INTEGER          NOT NULL,
  total_alpha DOUBLE PRECISION NOT NULL,
  -- Epoch MILLISECONDS, like every other captured_at in this database. #9382 is
  -- the standing reminder of what a seconds value does here: read as ms it
  -- lands in 1970, and a staleness guard then pins the row permanently.
  captured_at BIGINT           NOT NULL,
  PRIMARY KEY (hotkey, netuid)
);

-- The serving read: price one coldkey's positions, which are looked up by the
-- (hotkey, netuid) pairs those positions name.
CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_netuid
  ON hotkey_alpha (netuid, hotkey);

-- The staleness watchdog scans by capture time across every hotkey.
CREATE INDEX IF NOT EXISTS idx_hotkey_alpha_captured
  ON hotkey_alpha (captured_at);
