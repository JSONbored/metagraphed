// Per-UID daily metagraph HISTORY (block-explorer Tier-1, epic #1345 / depth #1302).
//
// The rollup snapshots the live `neurons` table into the dated `neuron_daily`
// table once a day (its own cron); the read builders reuse the live formatters
// (metagraph-neurons.mjs) so a historical row is byte-identical in shape to a live
// one. Pure + injectable for tests — the Worker handlers run the D1 query and call
// these.
import {
  NEURON_INSERT_COLUMNS,
  NEURON_COLUMNS,
  formatNeuron,
} from "./metagraph-neurons.mjs";

// Columns copied verbatim from `neurons` into `neuron_daily` (identical shape).
const ROLLUP_COLUMNS = NEURON_INSERT_COLUMNS;

// History windows. Deliberately NOT analyticsWindow (which only understands
// 7d/30d and clamps anything else to 400 days). `all` → no lower bound.
export const HISTORY_WINDOWS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
  all: null,
};
export const DEFAULT_HISTORY_WINDOW = "30d";
// Bounds any single time-series response (1y = 365 daily points < this cap).
export const MAX_HISTORY_POINTS = 400;

export function parseHistoryWindow(value) {
  const v = typeof value === "string" && value ? value : DEFAULT_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(HISTORY_WINDOWS).join(", ")}`,
      },
    };
  }
  return { label: v, days: HISTORY_WINDOWS[v] };
}

// Validates the ?date= param for as-of reads (YYYY-MM-DD). Range/real-date checks
// are left to SQLite (an impossible date simply matches no rows → empty 200).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidSnapshotDate(value) {
  return typeof value === "string" && DATE_RE.test(value);
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Daily rollup: snapshot the current `neurons` table into `neuron_daily` for the
 * captured UTC day. A single atomic INSERT...SELECT in the health DB:
 *  - WHERE captured_at = MAX(captured_at): one consistent snapshot stamp, so a
 *    concurrent partial load can't bleed two stamps into a single day.
 *  - snapshot_date = the UTC day of that captured_at, computed in SQL.
 *  - ON CONFLICT(netuid,uid,snapshot_date) DO UPDATE: intra-day re-runs are
 *    idempotent (the row reflects the last capture that UTC day).
 * Returns {rolled, rows} for cron observability; the caller .catch-isolates it so a
 * failure never affects the rest of the scheduled run.
 */
export async function rollupNeuronDaily(env, { now = Date.now() } = {}) {
  const db = env?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { rolled: false, reason: "no-db" };
  const cols = ROLLUP_COLUMNS.join(", ");
  const setClause = ROLLUP_COLUMNS.filter((c) => c !== "netuid" && c !== "uid")
    .map((c) => `${c} = excluded.${c}`)
    .concat("updated_at = excluded.updated_at")
    .join(", ");
  const sql =
    `INSERT INTO neuron_daily (${cols}, snapshot_date, updated_at) ` +
    `SELECT ${cols}, date(captured_at / 1000, 'unixepoch'), ? ` +
    `FROM neurons WHERE captured_at = (SELECT MAX(captured_at) FROM neurons) ` +
    `ON CONFLICT(netuid, uid, snapshot_date) DO UPDATE SET ${setClause}`;
  const res = await db.prepare(sql).bind(now).run();
  return { rolled: true, rows: res?.meta?.changes ?? null };
}

// SELECT list for reading a neuron_daily row back as a live-shaped neuron
// (formatNeuron consumes NEURON_COLUMNS) plus the history-specific snapshot_date.
export const NEURON_DAILY_READ_COLUMNS = `snapshot_date, ${NEURON_COLUMNS}`;

// Per-UID time series: one point per snapshot_date (the handler queries newest
// first, bounded by MAX_HISTORY_POINTS), each a live-shaped neuron plus its date.
export function buildNeuronHistory(rows, netuid, uid, { window } = {}) {
  return {
    schema_version: 1,
    netuid,
    uid,
    window: window ?? null,
    point_count: rows.length,
    points: rows.map((r) => ({
      snapshot_date: r.snapshot_date,
      captured_at: toIso(r.captured_at),
      block_number: r.block_number ?? null,
      ...formatNeuron(r),
    })),
  };
}

// Per-subnet metric-over-time: the daily count + a couple of cheap aggregates per
// snapshot_date (newest first), for a subnet-level history sparkline without
// shipping every UID. Rows come from a GROUP BY snapshot_date query.
export function buildSubnetHistory(rows, netuid, { window } = {}) {
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: rows.length,
    points: rows.map((r) => ({
      snapshot_date: r.snapshot_date,
      neuron_count: r.neuron_count ?? null,
      validator_count: r.validator_count ?? null,
      total_stake_tao: r.total_stake_tao ?? null,
      total_emission_tao: r.total_emission_tao ?? null,
    })),
  };
}
