-- #10811: give the subnet-ownership lane somewhere to write.
--
-- The lane has existed in metagraphed-infra since 2026-08-03 and writes
-- Postgres DIRECTLY (`DATABASE_URL`, not a sync route), so unlike every other
-- poller lane there is no handler in this repo that would have failed loudly
-- when the destination went missing. It resolves
-- `SubtensorModule::SubnetOwnerHotkey(netuid)` -> `Owner(hotkey)` for every
-- netuid in `NetworksAdded`, upserts the card, and appends to the history only
-- when the owner actually changed.
--
-- BOTH TABLES WERE ABSENT FROM NEON ENTIRELY. `to_regclass` returned null for
-- each, and nothing in `information_schema` matched `%ownership%`. They existed
-- on the old indexer box, whose Postgres seeded the lakehouse on 2026-08-02 --
-- which is why `chain.subnet_ownership_history` holds 135 rows across 129
-- subnets while Neon holds none. The move to Neon simply never brought them.
--
-- The visible cost: `/api/v1/subnets/{netuid}/ownership-history` answers
-- `data: []` for EVERY subnet, with no `degraded` flag, over data we hold.
-- That half is #10812; this is the store it needs.
--
-- COLUMNS ARE THE PRODUCER'S, NOT A REDESIGN. Taken from the lane's own
-- INSERTs (`jobs/subnet_ownership.rs`) so the first pass after the image lands
-- writes without a migration chasing it:
--
--   INSERT INTO subnet_ownership (netuid, owner_hotkey, owner_coldkey, captured_at)
--     ... ON CONFLICT (netuid) DO UPDATE
--   INSERT INTO subnet_ownership_history (netuid, owner_hotkey, owner_coldkey, captured_at)
--   DELETE FROM subnet_ownership WHERE netuid <> ALL($1)
--
-- so `netuid` is the card's PRIMARY KEY (the upsert's conflict target), the
-- history takes no `id` from the producer (hence BIGSERIAL, matching 0021),
-- and both key columns are NOT NULL because the Rust side binds `String`, not
-- `Option<String>` -- a netuid whose owner resolves to the zero account is
-- pruned rather than written null.
CREATE TABLE IF NOT EXISTS subnet_ownership (
  netuid        INTEGER PRIMARY KEY,
  owner_hotkey  TEXT   NOT NULL,
  owner_coldkey TEXT   NOT NULL,
  -- Epoch milliseconds. BIGINT for the reason 0006 documents: INTEGER
  -- truncates silently rather than erroring.
  captured_at   BIGINT NOT NULL
);

-- The staleness sweep's read (`MAX(captured_at)`), and a "which subnets are
-- stalest" ordering. The card is 129 rows, so this is for the sweep's shape
-- rather than for its cost.
CREATE INDEX IF NOT EXISTS subnet_ownership_captured_at_idx
  ON subnet_ownership (captured_at DESC);

CREATE TABLE IF NOT EXISTS subnet_ownership_history (
  id            BIGSERIAL PRIMARY KEY,
  netuid        INTEGER NOT NULL,
  owner_hotkey  TEXT   NOT NULL,
  owner_coldkey TEXT   NOT NULL,
  captured_at   BIGINT NOT NULL
);

-- The serving read: one subnet's ownership trail, oldest first. Matches
-- `loadSubnetOwnerObservations`' shape, which the lakehouse fallback already
-- uses, so the hot and cold legs sort identically.
CREATE INDEX IF NOT EXISTS subnet_ownership_history_netuid_captured_at_idx
  ON subnet_ownership_history (netuid, captured_at);
