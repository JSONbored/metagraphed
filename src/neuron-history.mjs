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

// Keep only well-formed backfill rows: integer netuid+uid, a YYYY-MM-DD
// snapshot_date, and a non-empty hotkey (mirrors the forward path, which drops
// null-hotkey UIDs). Anything else is silently dropped so a partial/garbage batch
// can never poison the table.
export function validNeuronDailyRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row) =>
      row &&
      Number.isInteger(row.netuid) &&
      Number.isInteger(row.uid) &&
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
