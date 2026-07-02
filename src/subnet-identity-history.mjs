// On-chain subnet identity history (#1647): detect SubnetIdentitiesV3 changes from
// the hourly profiles artifact, store append-only rows in D1, and serve a paginated
// timeline + previously_known_as provenance hints. Pure + injectable for tests.

import { encodeCursor, decodeCursor } from "./cursor.mjs";
import { sanitizeIdentityHistoryFields } from "./chain-identity-sanitize.mjs";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.mjs";

const D1_STATEMENTS_PER_BATCH = 100;

export const IDENTITY_HISTORY_COLUMNS =
  "id, netuid, block_number, observed_at, subnet_name, symbol, description, github_repo, subnet_url, discord, logo_url, identity_hash";

const READ_COLUMNS =
  "id, block_number, observed_at, subnet_name, symbol, description, github_repo, subnet_url, discord, logo_url, identity_hash";

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

export function identitySnapshotFromProfile(profile) {
  const identity = profile?.native_identity;
  if (!identity || typeof identity !== "object") return null;
  return sanitizeIdentityHistoryFields({
    subnet_name: identity.subnet_name ?? null,
    symbol: profile.symbol ?? null,
    description: identity.description ?? null,
    github_repo: identity.github_url ?? null,
    subnet_url: identity.website_url ?? null,
    discord: identity.discord ?? identity.discord_url ?? null,
    logo_url: identity.logo_url ?? null,
  });
}

export async function identityHash(snapshot) {
  if (!snapshot) return null;
  return sha256Hex(stableStringify(snapshot));
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function normalizeName(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function formatIdentityHistoryEntry(row) {
  if (!row || typeof row !== "object") return null;
  const entry = sanitizeIdentityHistoryFields({
    block_number:
      row.block_number == null
        ? null
        : Number.isSafeInteger(Number(row.block_number))
          ? Number(row.block_number)
          : null,
    observed_at: toIso(Number(row.observed_at)),
    subnet_name: row.subnet_name ?? null,
    symbol: row.symbol ?? null,
    description: row.description ?? null,
    github_repo: row.github_repo ?? null,
    subnet_url: row.subnet_url ?? null,
    discord: row.discord ?? null,
    logo_url: row.logo_url ?? null,
    identity_hash: row.identity_hash ?? null,
  });
  return entry;
}

export function buildSubnetIdentityHistory(
  rows,
  netuid,
  { limit, offset, nextCursor } = {},
) {
  const entries = (rows || []).map(formatIdentityHistoryEntry).filter(Boolean);
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

export function derivePreviouslyKnownAs(rows, currentName) {
  const current = normalizeName(currentName);
  const seen = new Set();
  const names = [];
  for (const row of rows || []) {
    const name = normalizeName(row?.subnet_name);
    if (!name || name === current || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function overlayPreviouslyKnownAs(detail, names) {
  if (!detail || typeof detail !== "object") return detail;
  if (!Array.isArray(names) || names.length === 0) return detail;
  return { ...detail, previously_known_as: names };
}

async function runStatementBatches(db, statements) {
  for (let i = 0; i < statements.length; i += D1_STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + D1_STATEMENTS_PER_BATCH));
  }
}

async function latestIdentityHashes(db) {
  const res = await db
    .prepare(
      `SELECT h.netuid, h.identity_hash
       FROM subnet_identity_history h
       INNER JOIN (
         SELECT netuid, MAX(id) AS max_id
         FROM subnet_identity_history
         GROUP BY netuid
       ) latest ON h.netuid = latest.netuid AND h.id = latest.max_id`,
    )
    .all();
  return new Map(
    (res?.results || []).map((row) => [row.netuid, row.identity_hash]),
  );
}

async function latestBlockNumber(db) {
  try {
    const res = await db
      .prepare("SELECT MAX(block_number) AS block_number FROM blocks")
      .all();
    const block = res?.results?.[0]?.block_number;
    return Number.isSafeInteger(block) && block > 0 ? block : null;
  } catch {
    return null;
  }
}

/**
 * Diff profiles.json native_identity against the last stored hash per netuid;
 * append a row when any tracked field changes. Idempotent when unchanged.
 */
export async function recordSubnetIdentityChanges(
  env,
  { profiles, now = Date.now(), db } = {},
) {
  const database = db || env?.METAGRAPH_HEALTH_DB;
  if (!database?.prepare || !Array.isArray(profiles) || profiles.length === 0) {
    return { recorded: false, reason: "unavailable" };
  }
  let latestByNetuid;
  try {
    latestByNetuid = await latestIdentityHashes(database);
  } catch {
    return { recorded: false, reason: "read_failed" };
  }
  const blockNumber = await latestBlockNumber(database);
  const stmt = database.prepare(
    `INSERT INTO subnet_identity_history
       (netuid, block_number, observed_at, subnet_name, symbol, description,
        github_repo, subnet_url, discord, logo_url, identity_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statements = [];
  for (const profile of profiles) {
    if (!Number.isInteger(profile?.netuid)) continue;
    const snapshot = identitySnapshotFromProfile(profile);
    if (!snapshot) continue;
    const hash = await identityHash(snapshot);
    if (latestByNetuid.get(profile.netuid) === hash) continue;
    statements.push(
      stmt.bind(
        profile.netuid,
        blockNumber,
        now,
        snapshot.subnet_name,
        snapshot.symbol,
        snapshot.description,
        snapshot.github_repo,
        snapshot.subnet_url,
        snapshot.discord,
        snapshot.logo_url,
        hash,
      ),
    );
    latestByNetuid.set(profile.netuid, hash);
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

export async function loadSubnetIdentityHistory(
  d1,
  netuid,
  { limit, offset, cursor } = {},
) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params = [netuid];
  let sql = `SELECT ${READ_COLUMNS} FROM subnet_identity_history WHERE netuid = ?`;
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
  return buildSubnetIdentityHistory(rows, netuid, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}

export async function loadPreviouslyKnownAs(d1, netuid, currentName) {
  const rows = await d1(
    `SELECT subnet_name, MAX(observed_at) AS observed_at
     FROM subnet_identity_history
     WHERE netuid = ? AND subnet_name IS NOT NULL AND TRIM(subnet_name) != ''
     GROUP BY subnet_name
     ORDER BY observed_at DESC`,
    [netuid],
  );
  return derivePreviouslyKnownAs(rows, currentName);
}

export async function loadPreviouslyKnownAsForNetuids(d1, entries) {
  const items = entries || [];
  const netuids = items
    .map((entry) => entry?.netuid)
    .filter((netuid) => Number.isInteger(netuid));
  if (!netuids.length) return new Map();
  const placeholders = netuids.map(() => "?").join(", ");
  const rows = await d1(
    `SELECT netuid, subnet_name, MAX(observed_at) AS observed_at
     FROM subnet_identity_history
     WHERE netuid IN (${placeholders})
       AND subnet_name IS NOT NULL AND TRIM(subnet_name) != ''
     GROUP BY netuid, subnet_name
     ORDER BY netuid, observed_at DESC`,
    netuids,
  );
  const currentByNetuid = new Map(
    items
      .filter((entry) => Number.isInteger(entry?.netuid))
      .map((entry) => [entry.netuid, entry.name ?? entry.native_name ?? null]),
  );
  const grouped = new Map();
  for (const row of rows || []) {
    let list = grouped.get(row.netuid);
    if (!list) grouped.set(row.netuid, (list = []));
    list.push(row);
  }
  const out = new Map();
  for (const [netuid, list] of grouped) {
    const names = derivePreviouslyKnownAs(list, currentByNetuid.get(netuid));
    if (names.length) out.set(netuid, names);
  }
  return out;
}
