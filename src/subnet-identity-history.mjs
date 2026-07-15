// On-chain subnet identity history (#1647): detect SubnetIdentitiesV3 changes from
// the hourly profiles artifact, store append-only rows in D1, and serve a paginated
// timeline + previously_known_as provenance hints. Pure + injectable for tests.

import { encodeCursor, decodeCursor } from "./cursor.mjs";
import {
  sanitizeIdentityHistoryFields,
  sanitizeIdentityHistoryText,
} from "./chain-identity-sanitize.mjs";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.mjs";

const D1_STATEMENTS_PER_BATCH = 100;

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

// Non-negative integer block height, or null for absent/blank/negative cells.
// Mirrors toBlockNumber in account-events.mjs: Number("") / Number("   ") both
// coerce to 0, so a blank D1 cell must be rejected before the Number() coercion.
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

function normalizeName(value) {
  const sanitized = sanitizeIdentityHistoryText(value);
  return typeof sanitized === "string" && sanitized.trim()
    ? sanitized.trim()
    : null;
}

export function formatIdentityHistoryEntry(row) {
  if (!row || typeof row !== "object") return null;
  const entry = sanitizeIdentityHistoryFields({
    block_number: toBlockNumber(row.block_number),
    observed_at: toIso(row.observed_at),
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

// D1 hands INTEGER columns back as numeric strings on GROUP BY / JOIN read paths
// (the convention account-events.mjs and analytics-routes.mjs coerce for). Accept
// ONLY a real number or an all-digits string so a blank/null/false cell is rejected
// rather than read as a valid subnet 0 (Number("") === Number(null) === 0). A raw
// string key otherwise silently misses the integer netuid the callers look up by.
function rowNetuid(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
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
  const map = new Map();
  for (const row of res?.results || []) {
    const netuid = rowNetuid(row.netuid);
    if (netuid != null) map.set(netuid, row.identity_hash);
  }
  return map;
}

async function latestBlockNumber(db) {
  try {
    const res = await db
      .prepare("SELECT MAX(block_number) AS block_number FROM blocks")
      .all();
    const raw = res?.results?.[0]?.block_number;
    if (raw == null || raw === "") return null;
    const block = Number(raw);
    return Number.isSafeInteger(block) && block > 0 ? block : null;
  } catch {
    return null;
  }
}

/**
 * #4832 gap-closure: mirror recordSubnetIdentityChanges' D1 write into
 * Postgres via the DATA_API service binding, called directly from
 * writeSubnetSnapshot (src/health-prober.mjs) rather than through
 * workers/api.mjs's public proxy layer -- this runs from WITHIN the main
 * Worker's own hourly cron tick, a pure internal RPC hop, not a public-
 * internet crossing (unlike the other three #4832 sync routes, which are
 * driven by external GitHub Actions workflows and therefore cross the
 * public internet through the proxy). Best-effort: never throws, and a
 * failure here must never block the D1 write above (the primary contract)
 * or the rest of writeSubnetSnapshot's own work.
 */
export async function syncSubnetIdentityToPostgres(env, { profiles } = {}) {
  if (!env?.DATA_API || !env?.SUBNET_IDENTITY_SYNC_SECRET) {
    return { synced: false, reason: "unavailable" };
  }
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { synced: false, reason: "no_profiles" };
  }
  try {
    const upstream = await env.DATA_API.fetch(
      new Request(
        "https://api.metagraph.sh/api/v1/internal/subnet-identity-sync",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-subnet-identity-sync-token": env.SUBNET_IDENTITY_SYNC_SECRET,
          },
          body: JSON.stringify(profiles),
        },
      ),
    );
    if (!upstream.ok) {
      return { synced: false, reason: `status_${upstream.status}` };
    }
    return { synced: true };
  } catch {
    return { synced: false, reason: "fetch_failed" };
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
  } catch (error) {
    // #4832 gap-closure follow-up: a swallowed D1 error here (prod schema
    // drift, a locked/unavailable DB) dark-served the identity-history
    // write for an unknown stretch before anyone noticed -- same failure
    // class d1All was hardened against, see that fix's own comment.
    console.error(
      "[recordSubnetIdentityChanges]",
      String(error?.message ?? error),
    );
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
  } catch (error) {
    console.error(
      "[recordSubnetIdentityChanges]",
      String(error?.message ?? error),
    );
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

// Groups already-fetched (netuid, subnet_name, observed_at) rows by netuid and
// derives each subnet's alias list — split out of loadPreviouslyKnownAsForNetuids
// so a Postgres-tier caller (workers/api.mjs) can reuse the exact same grouping
// instead of duplicating it, the same way the single-netuid derivePreviouslyKnownAs
// above is shared by both storage tiers.
export function deriveNetuidGroupedAliases(rows, entries) {
  const currentByNetuid = new Map(
    (entries || [])
      .filter((entry) => Number.isInteger(entry?.netuid))
      .map((entry) => [entry.netuid, entry.native_name ?? entry.name ?? null]),
  );
  const grouped = new Map();
  for (const row of rows || []) {
    // Coerce so the group keys on the same integer the caller and currentByNetuid
    // use — a raw string key both drops the alias from the agent-catalog lookup
    // and lets the current name leak into the history.
    const netuid = rowNetuid(row.netuid);
    if (netuid == null) continue;
    let list = grouped.get(netuid);
    if (!list) grouped.set(netuid, (list = []));
    list.push(row);
  }
  const out = new Map();
  for (const [netuid, list] of grouped) {
    const names = derivePreviouslyKnownAs(list, currentByNetuid.get(netuid));
    if (names.length) out.set(netuid, names);
  }
  return out;
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
  return deriveNetuidGroupedAliases(rows, items);
}
