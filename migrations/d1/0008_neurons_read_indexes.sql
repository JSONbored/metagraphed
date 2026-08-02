-- Read-path indexes for the neurons family (the READ half of the box
-- decommission; the write half + tables are migrations/d1/0007_neurons.sql,
-- already applied to production, which is why these land as their own
-- migration instead of edits to 0007).
--
-- 0007 ships idx_neuron_daily_date_netuid (snapshot_date, netuid) for the
-- network-wide window scans (/subnets/movers, /chain/turnover). The other
-- two access paths the D1 read dispatcher (workers/data-api.ts) ports have
-- no useful index yet:
--
--   hotkey-scoped daily series -- /validators/:hotkey/history and the
--   realized-return baseline windows (#7228) filter `hotkey = ? AND
--   validator_permit = 1` over a date range; without this the whole
--   ~multi-hundred-thousand-row table is scanned per request. Mirrors
--   Postgres's idx_nd_hotkey_date.
CREATE INDEX IF NOT EXISTS idx_neuron_daily_hotkey_date
  ON neuron_daily (hotkey, snapshot_date);

--   per-subnet daily aggregation -- /subnets/:netuid/history and the
--   concentration/performance/yield history routes group a date-windowed
--   slice of ONE subnet; the PK (netuid, uid, snapshot_date) leads with
--   netuid but orders by uid next, so a window scan reads the subnet's
--   entire history. Mirrors Postgres's idx_nd_netuid_date (minus its
--   INCLUDE list -- SQLite has no covering INCLUDE clause).
CREATE INDEX IF NOT EXISTS idx_neuron_daily_netuid_date
  ON neuron_daily (netuid, snapshot_date);
