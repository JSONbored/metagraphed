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

export function unsupportedWindowMessage(value, windows) {
  return `"${value}" is not a supported window. Supported: ${Object.keys(windows).join(", ")}.`;
}

export function parseHistoryWindow(value) {
  const v = typeof value === "string" && value ? value : DEFAULT_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: unsupportedWindowMessage(v, HISTORY_WINDOWS),
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

// D1 keeps a bounded hot window; older days live only in the R2 cold archive
// (written BEFORE any prune). 400 days (~13 months) keeps a ROLLING 1-year history
// permanently D1-served — "1 year ago" is always ≤ 400 days old, so every
// 7d/30d/90d/1y query is answered from D1 with zero R2 fallthrough. At the measured
// ~7.8 MB/day this caps the table ~3.1 GB — comfortably under D1's 10 GB limit.
// Only >13-month deep history ages into the R2 cold tier (served later by PR-A2b).
export const NEURON_DAILY_RETENTION_DAYS = 400;

// R2 cold-archive key: one immutable gzip-NDJSON object per subnet per UTC day.
export function coldArchiveKey(netuid, day) {
  return `metagraph/history/cold/netuid=${netuid}/${day}.ndjson.gz`;
}

// gzip a string via the Workers-native CompressionStream (no deps; also present
// in the Node test runtime).
async function gzipString(text) {
  const stream = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function latestRolledDay(db) {
  const res = await db
    .prepare("SELECT MAX(snapshot_date) AS day FROM neuron_daily")
    .bind()
    .all();
  return res?.results?.[0]?.day ?? null;
}

/**
 * Archive a day's neuron_daily snapshot to the R2 cold tier — one immutable
 * gzip-NDJSON object per subnet (coldArchiveKey), so a per-subnet as-of read
 * beyond the D1 hot window is a single small GET. Defaults to the latest rolled
 * day (the one the rollup just wrote). Returns {archived, day, subnets, rows}.
 * Caller .catch-isolates it; the prune is gated on its success.
 */
export async function archiveNeuronDaily(env, { day, db, bucket } = {}) {
  const database = db || env?.METAGRAPH_HEALTH_DB;
  const r2 = bucket || env?.METAGRAPH_ARCHIVE;
  if (!database?.prepare || !r2?.put) {
    return { archived: false, reason: "no-binding" };
  }
  const targetDay = day || (await latestRolledDay(database));
  if (!targetDay) return { archived: false, reason: "no-data" };
  const res = await database
    .prepare(
      `SELECT ${ROLLUP_COLUMNS.join(", ")}, snapshot_date FROM neuron_daily ` +
        "WHERE snapshot_date = ? ORDER BY netuid, uid",
    )
    .bind(targetDay)
    .all();
  const rows = res?.results ?? [];
  if (rows.length === 0) {
    return { archived: false, reason: "no-rows", day: targetDay };
  }
  const byNetuid = new Map();
  for (const row of rows) {
    let group = byNetuid.get(row.netuid);
    if (!group) byNetuid.set(row.netuid, (group = []));
    group.push(row);
  }
  let subnets = 0;
  for (const [netuid, subnetRows] of byNetuid) {
    const ndjson = subnetRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await r2.put(coldArchiveKey(netuid, targetDay), await gzipString(ndjson), {
      httpMetadata: {
        contentType: "application/x-ndjson",
        contentEncoding: "gzip",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    subnets += 1;
  }
  return { archived: true, day: targetDay, subnets, rows: rows.length };
}

function neuronDailyRetentionCutoff(now = Date.now()) {
  return new Date(now - NEURON_DAILY_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

async function prunableDays(db, cutoff) {
  const res = await db
    .prepare(
      "SELECT DISTINCT snapshot_date AS day FROM neuron_daily " +
        "WHERE snapshot_date < ? ORDER BY snapshot_date",
    )
    .bind(cutoff)
    .all();
  return (res?.results ?? []).map((r) => r.day).filter(Boolean);
}

/**
 * Archive every neuron_daily day that would be removed by the retention prune.
 * This closes the data-loss gap where a successful latest-day archive could gate
 * deletion of older days that had never been written to R2.
 */
export async function archivePrunableNeuronDaily(
  env,
  { now = Date.now(), db, bucket } = {},
) {
  const database = db || env?.METAGRAPH_HEALTH_DB;
  const r2 = bucket || env?.METAGRAPH_ARCHIVE;
  if (!database?.prepare || !r2?.put) {
    return { archived: false, reason: "no-binding" };
  }
  const cutoff = neuronDailyRetentionCutoff(now);
  const days = await prunableDays(database, cutoff);
  let rows = 0;
  let subnets = 0;
  const archivedDays = [];
  for (const day of days) {
    const res = await archiveNeuronDaily(env, {
      day,
      db: database,
      bucket: r2,
    });
    if (!res.archived) {
      return {
        archived: false,
        reason: "archive-failed",
        cutoff,
        day,
        days: archivedDays,
        failed: res,
      };
    }
    archivedDays.push(day);
    rows += res.rows ?? 0;
    subnets += res.subnets ?? 0;
  }
  return { archived: true, cutoff, days: archivedDays, subnets, rows };
}

/**
 * Prune neuron_daily rows older than the retention window from D1. The caller
 * gates this on a successful archive so a day is never deleted before it exists
 * in the R2 cold tier. Returns {pruned, cutoff, rows}.
 */
export async function pruneNeuronDaily(env, { now = Date.now() } = {}) {
  const db = env?.METAGRAPH_HEALTH_DB;
  if (!db?.prepare) return { pruned: false, reason: "no-db" };
  const cutoff = neuronDailyRetentionCutoff(now);
  const res = await db
    .prepare("DELETE FROM neuron_daily WHERE snapshot_date < ?")
    .bind(cutoff)
    .run();
  return { pruned: true, cutoff, rows: res?.meta?.changes ?? null };
}

// Backfill ingest (#1345 Phase 1): batched idempotent upsert of HISTORICAL
// neuron_daily rows produced by scripts/backfill-neuron-history.py. Each row already
// carries its own snapshot_date (the historical UTC day) + captured_at (that block's
// ms); updated_at is stamped server-side. Same column set + ON CONFLICT target as the
// forward rollup, so a backfilled row is byte-identical to a rolled one and any
// re-POST is a no-op upsert on the (netuid,uid,snapshot_date) PK. Column list + bind
// order are both driven off `cols`, so they cannot drift apart.
export function neuronDailyUpsertStatements(
  db,
  rows,
  { now = Date.now() } = {},
) {
  const cols = [...ROLLUP_COLUMNS, "snapshot_date"];
  const setClause = ROLLUP_COLUMNS.filter((c) => c !== "netuid" && c !== "uid")
    .map((c) => `${c} = excluded.${c}`)
    .concat("updated_at = excluded.updated_at")
    .join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const sql =
    `INSERT INTO neuron_daily (${cols.join(", ")}, updated_at) ` +
    `VALUES (${placeholders}, ?) ` +
    `ON CONFLICT(netuid, uid, snapshot_date) DO UPDATE SET ${setClause}`;
  return rows.map((row) =>
    db.prepare(sql).bind(...cols.map((c) => row[c] ?? null), now),
  );
}

const SNAPSHOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Keep only well-formed backfill rows: non-negative integer netuid+uid, a
// YYYY-MM-DD snapshot_date, and a non-empty hotkey (mirrors the forward path,
// which drops null-hotkey UIDs). Anything else is silently dropped so a
// partial/garbage batch can never poison the table.
export function validNeuronDailyRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row) =>
      row &&
      Number.isInteger(row.netuid) &&
      row.netuid >= 0 &&
      Number.isInteger(row.uid) &&
      row.uid >= 0 &&
      typeof row.snapshot_date === "string" &&
      SNAPSHOT_DATE_RE.test(row.snapshot_date) &&
      typeof row.hotkey === "string" &&
      row.hotkey.length > 0,
  );
}

// SELECT list for reading a neuron_daily row back as a live-shaped neuron
// (formatNeuron consumes NEURON_COLUMNS) plus the history-specific snapshot_date.
export const NEURON_DAILY_READ_COLUMNS = `snapshot_date, ${NEURON_COLUMNS}`;

// Per-UID time series: one point per snapshot_date (the handler queries newest
// first, bounded by MAX_HISTORY_POINTS), each a live-shaped neuron plus its date.
export function buildNeuronHistory(rows, netuid, uid, { window } = {}) {
  // Drop any malformed (non-object) row so the array only holds real points and
  // the count tracks it (point_count === points.length) -- mirroring the
  // blocks/extrinsics/metagraph builders' .filter(Boolean) guard (#1793). Reading
  // formatNeuron(r) first also means a null/undefined element degrades gracefully
  // instead of throwing on `r.snapshot_date`.
  const points = (rows || [])
    .map((r) => {
      const neuron = formatNeuron(r);
      if (!neuron) return null;
      return {
        snapshot_date: r.snapshot_date,
        captured_at: toIso(r.captured_at),
        block_number: r.block_number ?? null,
        ...neuron,
      };
    })
    .filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    uid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}

// Network-wide economics time series (#1307): roll the per-subnet daily
// subnet_snapshots rows up to ONE point per UTC day across all subnets. Each input
// row is {snapshot_date, total_stake_tao, alpha_price_tao, validator_count,
// miner_count, emission_share}; the handler reads them raw (not a GROUP BY) so the
// stake-weighted mean + median alpha price can be computed here. Rows arrive newest
// first; the output preserves that order. Null-safe throughout — a metric is null
// for a day only when NO subnet reported it.
export function buildEconomicsTrends(rows, { window } = {}) {
  const byDay = new Map(); // snapshot_date -> accumulator (insertion order = newest first)
  for (const r of rows || []) {
    const day = r.snapshot_date;
    if (day == null) continue;
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        subnet_count: 0,
        stake_sum: 0,
        stake_seen: false,
        validator_sum: 0,
        validator_seen: false,
        miner_sum: 0,
        miner_seen: false,
        emission_sum: 0,
        emission_seen: 0,
        weighted_price_num: 0, // Σ(price · stake)
        weighted_price_den: 0, // Σ(stake) over rows with a price
        prices: [], // for the unweighted median
      };
      byDay.set(day, acc);
    }
    acc.subnet_count += 1;
    const stake = toFiniteOrNull(r.total_stake_tao);
    const price = toFiniteOrNull(r.alpha_price_tao);
    const validators = toFiniteOrNull(r.validator_count);
    const miners = toFiniteOrNull(r.miner_count);
    const emission = toFiniteOrNull(r.emission_share);
    if (stake != null) {
      acc.stake_sum += stake;
      acc.stake_seen = true;
    }
    if (validators != null) {
      acc.validator_sum += validators;
      acc.validator_seen = true;
    }
    if (miners != null) {
      acc.miner_sum += miners;
      acc.miner_seen = true;
    }
    if (emission != null) {
      acc.emission_sum += emission;
      acc.emission_seen += 1;
    }
    if (price != null) {
      acc.prices.push(price);
      // Stake-weight the price; a positive stake is required for a weighted mean.
      if (stake != null && stake > 0) {
        acc.weighted_price_num += price * stake;
        acc.weighted_price_den += stake;
      }
    }
  }
  const days = [...byDay.entries()].map(([snapshot_date, acc]) => ({
    snapshot_date,
    subnet_count: acc.subnet_count,
    total_stake_tao: acc.stake_seen ? roundTao(acc.stake_sum) : null,
    alpha_price_tao_weighted:
      acc.weighted_price_den > 0
        ? roundPrice(acc.weighted_price_num / acc.weighted_price_den)
        : null,
    alpha_price_tao_median: median(acc.prices),
    validator_count: acc.validator_seen ? acc.validator_sum : null,
    miner_count: acc.miner_seen ? acc.miner_sum : null,
    mean_emission_share:
      acc.emission_seen > 0
        ? roundShare(acc.emission_sum / acc.emission_seen)
        : null,
  }));
  return {
    schema_version: 1,
    window: window ?? null,
    day_count: days.length,
    days,
  };
}

function toFiniteOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundTao(v) {
  return Math.round(v * 1e6) / 1e6;
}
// Round a TAO sum, preserving null — so an unrounded D1 SUM(stake_tao)/SUM(
// emission_tao) never leaks accumulated float noise, while a null SUM (cold/
// sparse day) stays null rather than collapsing to 0.
function roundTaoOrNull(v) {
  const n = toFiniteOrNull(v);
  return n == null ? null : roundTao(n);
}
function roundPrice(v) {
  return Math.round(v * 1e9) / 1e9;
}
function roundShare(v) {
  return Math.round(v * 1e6) / 1e6;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return roundPrice(raw);
}

// Per-subnet metric-over-time: the daily count + a couple of cheap aggregates per
// snapshot_date (newest first), for a subnet-level history sparkline without
// shipping every UID. Rows come from a GROUP BY snapshot_date query.
export function buildSubnetHistory(rows, netuid, { window } = {}) {
  // Drop any malformed (non-object) row so the count tracks the emitted array
  // (point_count === points.length) and a null/undefined element never throws on
  // `r.snapshot_date` -- mirroring the sibling feed builders' guard (#1793).
  const points = (rows || [])
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      snapshot_date: r.snapshot_date,
      neuron_count: r.neuron_count ?? null,
      validator_count: r.validator_count ?? null,
      // Round the per-day SUM(stake_tao)/SUM(emission_tao) to stop accumulated
      // float noise from leaking, matching buildEconomicsTrends above.
      total_stake_tao: roundTaoOrNull(r.total_stake_tao),
      total_emission_tao: roundTaoOrNull(r.total_emission_tao),
    }));
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}
