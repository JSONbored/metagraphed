// Personal (coldkey) chain identity history diff-tracking (#4326, epic
// #4301/5.2): detect account_identity changes against the last recorded hash
// per account and store append-only rows in D1. Mirrors
// src/subnet-identity-history.mjs's diff-and-append shape (subnet_hyperparams's
// own D1-side diff-and-append, recordSubnetHyperparamsChanges, was retired
// alongside its D1 write path -- see src/subnet-hyperparams-history.mjs's
// header), keyed by account instead of netuid, and originally run as an
// additional step inside the retired staged load (loadStagedAccountIdentity,
// removed in the D1→Postgres cutover #4772 — see workers/api.mjs's
// staged-loader note) rather than a separate pipeline.
//
// Read/format/build functions land here with the serving route (#4328/5.4),
// mirroring src/subnet-identity-history.mjs's read side exactly (keyed by
// account instead of netuid, and with no block_number column — account_identity
// carries no chain block height, only captured_at).

import {
  IDENTITY_FIELDS,
  sanitizeAccountIdentityFields,
} from "./account-identity.mjs";
import { encodeCursor, decodeCursor } from "./cursor.mjs";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.mjs";

const D1_STATEMENTS_PER_BATCH = 100;

const INSERT_COLUMNS = [
  "account",
  "observed_at",
  ...IDENTITY_FIELDS,
  "identity_hash",
];

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

function identitySnapshotFromRow(row) {
  const snapshot = {};
  for (const field of IDENTITY_FIELDS) snapshot[field] = row?.[field] ?? null;
  return snapshot;
}

/** Hash of the tracked identity fields only — stable regardless of the row's
 * account/captured_at, which change independently of the identity itself. */
export async function identityHash(snapshot) {
  if (!snapshot) return null;
  return sha256Hex(stableStringify(snapshot));
}

async function runStatementBatches(db, statements) {
  for (let i = 0; i < statements.length; i += D1_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + D1_STATEMENTS_PER_BATCH));
  }
}

async function latestIdentityHashes(db) {
  const res = await db
    .prepare(
      `SELECT h.account, h.identity_hash
       FROM account_identity_history h
       INNER JOIN (
         SELECT account, MAX(id) AS max_id
         FROM account_identity_history
         GROUP BY account
       ) latest ON h.account = latest.account AND h.id = latest.max_id`,
    )
    .all();
  const map = new Map();
  for (const row of res?.results || []) {
    if (typeof row.account === "string" && row.account) {
      map.set(row.account, row.identity_hash);
    }
  }
  return map;
}

/**
 * Diff the freshly-staged account_identity rows against the last stored hash
 * per account; append a row when any tracked identity field changes.
 * Idempotent when unchanged. `rows` are the same staged rows
 * loadStagedAccountIdentity upserts into the latest-only table — this runs
 * as an additional step in that same load, not a separate pipeline.
 */
export async function recordAccountIdentityChanges(
  env,
  { rows, now = Date.now(), db } = {},
) {
  const database = db || env?.METAGRAPH_HEALTH_DB;
  if (!database?.prepare || !Array.isArray(rows) || rows.length === 0) {
    return { recorded: false, reason: "unavailable" };
  }
  let latestByAccount;
  try {
    latestByAccount = await latestIdentityHashes(database);
  } catch {
    return { recorded: false, reason: "read_failed" };
  }
  const stmt = database.prepare(
    `INSERT INTO account_identity_history (${INSERT_COLUMNS.join(",")})
     VALUES (${INSERT_COLUMNS.map(() => "?").join(",")})`,
  );
  const statements = [];
  try {
    for (const row of rows) {
      if (typeof row?.account !== "string" || row.account.length === 0) {
        continue;
      }
      const snapshot = identitySnapshotFromRow(row);
      const hash = await identityHash(snapshot);
      if (latestByAccount.get(row.account) === hash) continue;
      const values = INSERT_COLUMNS.map((col) => {
        if (col === "account") return row.account;
        if (col === "observed_at") return now;
        if (col === "identity_hash") return hash;
        return snapshot[col];
      });
      statements.push(stmt.bind(...values));
      latestByAccount.set(row.account, hash);
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

const READ_COLUMNS = [
  "id",
  "observed_at",
  ...IDENTITY_FIELDS,
  "identity_hash",
].join(", ");

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatAccountIdentityHistoryEntry(row) {
  if (!row || typeof row !== "object") return null;
  const sanitized = sanitizeAccountIdentityFields(row);
  const entry = { observed_at: toIso(row.observed_at) };
  for (const field of IDENTITY_FIELDS) entry[field] = sanitized[field] ?? null;
  entry.identity_hash = row.identity_hash ?? null;
  return entry;
}

export function buildAccountIdentityHistory(
  rows,
  account,
  { limit, offset, nextCursor } = {},
) {
  const entries = (rows || [])
    .map(formatAccountIdentityHistoryEntry)
    .filter(Boolean);
  return {
    schema_version: 1,
    account,
    entry_count: entries.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    entries,
  };
}

export async function loadAccountIdentityHistory(
  d1,
  account,
  { limit, offset, cursor } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params = [account];
  let sql = `SELECT ${READ_COLUMNS} FROM account_identity_history WHERE account = ?`;
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
  return buildAccountIdentityHistory(rows, account, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}
