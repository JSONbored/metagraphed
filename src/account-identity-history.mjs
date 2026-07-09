// Personal (coldkey) chain identity history diff-tracking (#4326, epic
// #4301/5.2): detect account_identity changes against the last recorded hash
// per account and store append-only rows in D1. Mirrors
// src/subnet-hyperparams-history.mjs's recordSubnetHyperparamsChanges shape
// exactly (itself mirroring src/subnet-identity-history.mjs), keyed by
// account instead of netuid, running as an additional step inside the same
// staged load rather than a separate pipeline (workers/request-handlers/
// staging.mjs's loadStagedAccountIdentity).
//
// Capture-only for now, matching src/account-identity.mjs's own precedent:
// no read/format/build/route functions here yet — those land with the
// serving route in #4328 (5.4).

import { ACCOUNT_IDENTITY_INSERT_COLUMNS } from "./account-identity.mjs";

const D1_STATEMENTS_PER_BATCH = 100;

// The 7 tracked identity fields, derived from the latest-only table's own
// column list rather than hand-duplicated a second time — strips account
// (front) and captured_at (back), which this table carries as its own
// separately-typed id/observed_at columns instead.
const IDENTITY_FIELDS = ACCOUNT_IDENTITY_INSERT_COLUMNS.slice(1, -1);

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
