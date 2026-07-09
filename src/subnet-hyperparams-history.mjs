// Historical hyperparameter change tracking (#4309, epic #4301): detect
// subnet_hyperparams changes against the last recorded hash per netuid and
// store append-only rows in D1, served as a paginated per-subnet timeline.
// Forward-only for now — a full backfill needs archive-node state_call at
// past block heights (#2111). Mirrors src/subnet-identity-history.mjs's
// diff-and-append shape exactly; reuses subnet-hyperparams.mjs's field
// mapping (formatSubnetHyperparams) rather than re-deriving it, since a
// history entry's hyperparameters are the same 33-field shape as the
// latest-only route already formats.

import { encodeCursor, decodeCursor } from "./cursor.mjs";
import {
  formatSubnetHyperparams,
  SUBNET_HYPERPARAMS_INSERT_COLUMNS,
} from "./subnet-hyperparams.mjs";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.mjs";

const D1_STATEMENTS_PER_BATCH = 100;

// The 33 hyperparameter field names, derived from the latest-only table's own
// column list rather than hand-duplicated a second time (mirrors that file's
// own SUBNET_HYPERPARAMS_COLUMNS derivation) — strips netuid (front) and
// block_number/captured_at (back), which this table carries as its own
// separately-typed id/block_number/observed_at columns instead.
const HYPERPARAM_FIELDS = SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1, -2);

const READ_COLUMNS = [
  "id",
  "block_number",
  "observed_at",
  ...HYPERPARAM_FIELDS,
  "hyperparams_hash",
].join(", ");

// Column order for the INSERT below — everything the diff writes, in bind order.
const INSERT_COLUMNS = [
  "netuid",
  "block_number",
  "observed_at",
  ...HYPERPARAM_FIELDS,
  "hyperparams_hash",
];

// D1 boolean columns store 0/1 — the diff-writer's own row is a formatted
// hyperparameters object (real booleans from formatSubnetHyperparams), so it
// needs the same 0/1 flattening the latest-only staging loader does.
function toD1Flag(value) {
  return value ? 1 : 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash of the formatted (type-coerced) hyperparameters object — stable
 * regardless of the raw staged row's string-vs-number/0-1-vs-boolean shape. */
export async function hyperparamsHash(hyperparameters) {
  if (!hyperparameters) return null;
  return sha256Hex(stableStringify(hyperparameters));
}

function toBlockNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatHyperparamsHistoryEntry(row) {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: toBlockNumber(row.block_number),
    observed_at: toIso(row.observed_at),
    hyperparameters: formatSubnetHyperparams(row),
    hyperparams_hash: row.hyperparams_hash ?? null,
  };
}

export function buildSubnetHyperparamsHistory(
  rows,
  netuid,
  { limit, offset, nextCursor } = {},
) {
  const entries = (rows || [])
    .map(formatHyperparamsHistoryEntry)
    .filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    entry_count: entries.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    entries,
  };
}

async function runStatementBatches(db, statements) {
  for (let i = 0; i < statements.length; i += D1_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + D1_STATEMENTS_PER_BATCH));
  }
}

// Same D1-numeric-string coercion as subnet-identity-history.mjs's rowNetuid —
// a raw string key otherwise silently misses the integer netuid callers look
// up by (D1 hands INTEGER columns back as numeric strings on GROUP BY/JOIN).
function rowNetuid(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

async function latestHyperparamsHashes(db) {
  const res = await db
    .prepare(
      `SELECT h.netuid, h.hyperparams_hash
       FROM subnet_hyperparams_history h
       INNER JOIN (
         SELECT netuid, MAX(id) AS max_id
         FROM subnet_hyperparams_history
         GROUP BY netuid
       ) latest ON h.netuid = latest.netuid AND h.id = latest.max_id`,
    )
    .all();
  const map = new Map();
  for (const row of res?.results || []) {
    const netuid = rowNetuid(row.netuid);
    if (netuid != null) map.set(netuid, row.hyperparams_hash);
  }
  return map;
}

/**
 * Diff the freshly-staged subnet_hyperparams rows against the last stored
 * hash per netuid; append a row when any hyperparameter changes. Idempotent
 * when unchanged. `rows` are the same staged rows loadStagedSubnetHyperparams
 * upserts into the latest-only table — this runs as an additional step in
 * that same load, not a separate pipeline.
 */
export async function recordSubnetHyperparamsChanges(
  env,
  { rows, now = Date.now(), db } = {},
) {
  const database = db || env?.METAGRAPH_HEALTH_DB;
  if (!database?.prepare || !Array.isArray(rows) || rows.length === 0) {
    return { recorded: false, reason: "unavailable" };
  }
  let latestByNetuid;
  try {
    latestByNetuid = await latestHyperparamsHashes(database);
  } catch {
    return { recorded: false, reason: "read_failed" };
  }
  const stmt = database.prepare(
    `INSERT INTO subnet_hyperparams_history (${INSERT_COLUMNS.join(",")})
     VALUES (${INSERT_COLUMNS.map(() => "?").join(",")})`,
  );
  const statements = [];
  try {
    for (const row of rows) {
      // Rows only ever reach this function pre-validated by
      // validStagedSubnetHyperparamsRow (workers/request-handlers/staging.mjs),
      // which already guarantees an integer netuid — no rowNetuid() string
      // fallback needed here (that helper is for latestHyperparamsHashes'
      // D1 GROUP BY/JOIN read, which genuinely can hand back numeric strings).
      if (!Number.isInteger(row?.netuid)) continue;
      const netuid = row.netuid;
      const hyperparameters = formatSubnetHyperparams(row);
      const hash = await hyperparamsHash(hyperparameters);
      if (latestByNetuid.get(netuid) === hash) continue;
      const values = INSERT_COLUMNS.map((col) => {
        if (col === "netuid") return netuid;
        if (col === "block_number") return toBlockNumber(row.block_number);
        if (col === "observed_at") return now;
        if (col === "hyperparams_hash") return hash;
        const value = hyperparameters[col];
        return typeof value === "boolean" ? toD1Flag(value) : (value ?? null);
      });
      statements.push(stmt.bind(...values));
      latestByNetuid.set(netuid, hash);
    }
  } catch {
    return { recorded: false, reason: "write_failed" };
  }
  if (!statements.length) {
    return { recorded: true, rows: 0 };
  }
  try {
    await runStatementBatches(database, statements);
    return { recorded: true, rows: statements.length };
  } catch {
    return { recorded: false, reason: "write_failed" };
  }
}

export async function loadSubnetHyperparamsHistory(
  d1,
  netuid,
  { limit, offset, cursor } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params = [netuid];
  let sql = `SELECT ${READ_COLUMNS} FROM subnet_hyperparams_history WHERE netuid = ?`;
  if (useCursor) {
    sql += " AND (observed_at, id) < (?, ?)";
    params.push(cur[0], cur[1]);
  }
  sql += " ORDER BY observed_at DESC, id DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor =
    last && Number.isFinite(Number(last.observed_at))
      ? encodeCursor([Number(last.observed_at), Number(last.id)])
      : null;
  return buildSubnetHyperparamsHistory(rows, netuid, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}
