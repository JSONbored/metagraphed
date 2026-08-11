-- metagraphed-infra#414: store the shares the chain gives us, not only the
-- fraction we derive from them.
--
-- WHY THIS COLUMN IS THE FIX FOR A PRODUCER PROBLEM. `share_fraction` is
-- normalised across every row sharing a (hotkey, netuid) -- this coldkey's
-- shares over ALL delegators' shares for that pool. No single row can produce
-- it, so the poller buffers the WHOLE 762,577-row Alpha keyspace in memory
-- before it may write anything. Its own header says so.
--
-- Every difficulty in metagraphed-infra#414 follows from that one decision: a
-- chunk boundary cannot fall mid-pool without computing a fraction against a
-- partial denominator, a failed pass at minute 9 of 10 discards all nine
-- minutes, and the container holds the keyspace on its heap to do it.
--
-- Storing the raw value moves the normalisation to one SQL statement after the
-- prune, which the database does over the complete table. The producer then
-- streams rows as it walks them.
--
-- NUMERIC, NOT BIGINT. Shares are a u128 (`Shares.bits`), whose maximum is
-- ~3.4e38 against bigint's ~9.2e18. `numeric` is the only exact type that
-- holds it. It also travels as a STRING on the sync route, because a u128 does
-- not survive JSON's double: 2^53 is the last integer a JSON number represents
-- exactly, and these values run far past it.
--
-- NULLABLE, deliberately. The producer that sends it does not exist yet
-- (metagraphed-infra#414 step 2), so every existing row has no shares and the
-- normalisation below skips them. That makes this migration inert until the
-- poller changes, which is the property that lets it ship first.
ALTER TABLE nominator_positions
  ADD COLUMN IF NOT EXISTS shares numeric;

-- The normalisation reads (hotkey, netuid) and sums over it. The existing
-- primary-key-ish access pattern is per-coldkey (the prune) and per-hotkey (the
-- serve path), so the group this statement aggregates has no index behind it.
-- 123,057 rows makes a sequential scan cheap today; this keeps it cheap as the
-- table grows, and it is the same shape top-holders already groups by.
CREATE INDEX IF NOT EXISTS nominator_positions_hotkey_netuid_idx
  ON nominator_positions (hotkey, netuid);
