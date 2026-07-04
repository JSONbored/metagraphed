// A wallet's portfolio timeline: the daily trajectory of one hotkey's total
// stake, emission, footprint (subnet/position/validator counts) and overall
// return, rolled up per snapshot_date from the neuron_daily tier. The point-in-
// time companion to /accounts/{ss58}/portfolio (current cross-subnet card):
// this answers "is this wallet's stake/emission/reach growing or shrinking?"
// over a 7d/30d/90d window. Distinct from /accounts/{ss58}/history (raw event
// feed) and /accounts/{ss58}/stake-flow (net capital movement) — those track
// individual actions and flows; this tracks the standing balance each day.
// Pure + exported for unit tests; the Worker does the windowed D1 read + envelope.
// Null-safe: no rows -> schema-stable empty series.

import { DAY_MS } from "../workers/config.mjs";

// The neuron_daily columns the timeline reads for one hotkey.
export const ACCOUNT_PORTFOLIO_HISTORY_READ_COLUMNS =
  "snapshot_date, netuid, uid, stake_tao, emission_tao, validator_permit";

// One hotkey over 90 days spans few subnets (a validator on ~40 subnets × 90d ≈
// 3.6k rows); this cap is a safety valve on a pathological wallet, far above any
// real footprint. The builder drops a truncated oldest day so every point is whole.
export const ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP = 20_000;

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision.
const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits
// string, so a blank/null/false cell is rejected rather than read as 0.
function toInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A snapshot_date cell must be a real YYYY-MM-DD string; anything else is dropped
// so a junk row can't open a bogus day bucket.
function toSnapshotDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}

// Fold one day's neuron_daily rows into a single portfolio point. Distinct
// netuids give the subnet footprint; each row is a position; validator_permit=1
// marks a validator seat. Emission/stake are summed across the wallet's seats.
function portfolioHistoryPoint(date, dayRows) {
  const netuids = new Set();
  let validatorCount = 0;
  let totalStake = 0;
  let totalEmission = 0;
  for (const row of dayRows) {
    const netuid = toInt(row?.netuid);
    if (netuid != null) netuids.add(netuid);
    if (Number(row?.validator_permit) === 1) validatorCount += 1;
    totalStake += toNumber(row?.stake_tao);
    totalEmission += toNumber(row?.emission_tao);
  }
  return {
    snapshot_date: date,
    subnet_count: netuids.size,
    position_count: dayRows.length,
    validator_count: validatorCount,
    miner_count: dayRows.length - validatorCount,
    total_stake_tao: round9(totalStake),
    total_emission_tao: round9(totalEmission),
    // Overall wallet return that day: emission per stake (null with no stake).
    overall_yield: totalStake > 0 ? round9(totalEmission / totalStake) : null,
  };
}

// Group one hotkey's neuron_daily rows into a per-day portfolio series. Rows are
// read newest-first; points come back newest-first too. When the read hit the
// cap the oldest day may be partial, so it's dropped (capped=true) to keep every
// returned point whole. Null-safe: junk/sparse rows yield a schema-stable series.
export function buildAccountPortfolioHistory(rows, ss58, options = {}) {
  const { window = "30d", capped = false } = options;
  const list = Array.isArray(rows) ? rows : [];
  // Preserve newest-first arrival order of the day buckets.
  const byDate = new Map();
  for (const row of list) {
    const date = toSnapshotDate(row?.snapshot_date);
    if (date == null) continue;
    let bucket = byDate.get(date);
    if (!bucket) {
      bucket = [];
      byDate.set(date, bucket);
    }
    bucket.push(row);
  }
  const dates = [...byDate.keys()];
  // Drop the oldest (last) day when the read was truncated — it may be partial.
  if (capped && dates.length > 1) {
    dates.pop();
  }
  const points = dates.map((date) =>
    portfolioHistoryPoint(date, byDate.get(date)),
  );
  return {
    schema_version: 1,
    ss58,
    window,
    point_count: points.length,
    points,
  };
}

// Shared D1 loader (REST + MCP parity): read this hotkey's neuron_daily rows
// within the window, newest-first, capped, and shape the timeline. The window's
// inclusive lower bound (the oldest in-window snapshot_date) is derived here so
// both surfaces share one cutoff. Cold/absent -> empty series.
export async function loadAccountPortfolioHistory(d1, ss58, options = {}) {
  const { windowLabel = "30d", windowDays = 30 } = options;
  const cutoff = new Date(Date.now() - windowDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await d1(
    `SELECT ${ACCOUNT_PORTFOLIO_HISTORY_READ_COLUMNS} FROM neuron_daily ` +
      `WHERE hotkey = ? AND snapshot_date >= ? ORDER BY snapshot_date DESC LIMIT ?`,
    [ss58, cutoff, ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP],
  );
  const capped =
    Array.isArray(rows) && rows.length >= ACCOUNT_PORTFOLIO_HISTORY_ROW_CAP;
  return buildAccountPortfolioHistory(rows, ss58, {
    window: windowLabel,
    capped,
  });
}
