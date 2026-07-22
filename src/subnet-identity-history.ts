// On-chain subnet identity history (#1647): detect SubnetIdentitiesV3 changes from
// the hourly profiles artifact and serve a paginated timeline +
// previously_known_as provenance hints (read side still tiered D1/Postgres,
// see loadSubnetIdentityHistory below). The append-only write itself is
// Postgres-only now (syncSubnetIdentityToPostgres in this file, called from
// writeSubnetSnapshot) -- D1's own write path is retired (2026-07-16, see
// recordSubnetIdentityChanges' own header comment). Pure + injectable for
// tests.

import { encodeCursor, decodeCursor } from "./cursor.ts";
import {
  sanitizeIdentityHistoryFields,
  sanitizeIdentityHistoryText,
} from "./chain-identity-sanitize.ts";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.ts";
import { tryPostgresTier } from "../workers/postgres-tier.ts";

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

const READ_COLUMNS =
  "id, block_number, observed_at, subnet_name, symbol, description, github_repo, subnet_url, discord, logo_url, identity_hash";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Row;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function sha256Hex(text: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function identitySnapshotFromProfile(
  profile: Row | null | undefined,
): Row | null {
  const identity = profile?.native_identity as Row | null | undefined;
  if (!identity || typeof identity !== "object") return null;
  return sanitizeIdentityHistoryFields({
    subnet_name: identity.subnet_name ?? null,
    symbol: profile?.symbol ?? null,
    description: identity.description ?? null,
    github_repo: identity.github_url ?? null,
    subnet_url: identity.website_url ?? null,
    discord: identity.discord ?? identity.discord_url ?? null,
    logo_url: identity.logo_url ?? null,
  });
}

export async function identityHash(snapshot: unknown): Promise<string | null> {
  if (!snapshot) return null;
  return sha256Hex(stableStringify(snapshot));
}

// Non-negative integer block height, or null for absent/blank/negative cells.
// Mirrors toBlockNumber in account-events.mjs: Number("") / Number("   ") both
// coerce to 0, so a blank D1 cell must be rejected before the Number() coercion.
function toBlockNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeName(value: unknown): string | null {
  const sanitized = sanitizeIdentityHistoryText(value);
  return typeof sanitized === "string" && sanitized.trim()
    ? sanitized.trim()
    : null;
}

export function formatIdentityHistoryEntry(row: unknown): Row | null {
  if (!row || typeof row !== "object") return null;
  const record = row as Row;
  const entry = sanitizeIdentityHistoryFields({
    block_number: toBlockNumber(record.block_number),
    observed_at: toIso(record.observed_at),
    subnet_name: record.subnet_name ?? null,
    symbol: record.symbol ?? null,
    description: record.description ?? null,
    github_repo: record.github_repo ?? null,
    subnet_url: record.subnet_url ?? null,
    discord: record.discord ?? null,
    logo_url: record.logo_url ?? null,
    identity_hash: record.identity_hash ?? null,
  });
  return entry;
}

export function buildSubnetIdentityHistory(
  rows: unknown[] | null | undefined,
  netuid: unknown,
  {
    limit,
    offset,
    nextCursor,
  }: { limit?: unknown; offset?: unknown; nextCursor?: unknown } = {},
): Row {
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

export function derivePreviouslyKnownAs(
  rows: Row[] | null | undefined,
  currentName: unknown,
): string[] {
  const current = normalizeName(currentName);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const row of rows || []) {
    const name = normalizeName(row?.subnet_name);
    if (!name || name === current || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function overlayPreviouslyKnownAs(
  detail: unknown,
  names: string[] | null | undefined,
): unknown {
  if (!detail || typeof detail !== "object") return detail;
  if (!Array.isArray(names) || names.length === 0) return detail;
  return { ...(detail as Row), previously_known_as: names };
}

// D1 hands INTEGER columns back as numeric strings on GROUP BY / JOIN read paths
// (the convention account-events.mjs and analytics-routes.mjs coerce for). Accept
// ONLY a real number or an all-digits string so a blank/null/false cell is rejected
// rather than read as a valid subnet 0 (Number("") === Number(null) === 0). A raw
// string key otherwise silently misses the integer netuid the callers look up by.
function rowNetuid(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// D1 retirement (2026-07-16, item 8 of the D1->Postgres cleanup): used to
// query D1's own subnet_identity_history directly; now reads the same latest-
// per-netuid hash via the Postgres-backed internal endpoint (workers/data-
// api.mjs's /api/v1/internal/subnet-identity-latest-hashes), reusing
// METAGRAPH_SUBNET_IDENTITY_SOURCE (same table, already flipped to postgres).
// An unavailable/off tier degrades to an empty map -- every profile then
// reads as "changed" for that one run, the same degrade recordSubnetIdentity
// Changes already tolerates on a cold table.
async function latestIdentityHashes(env: Env): Promise<Map<number, unknown>> {
  const pg = await tryPostgresTier(
    env,
    new Request(
      "https://api.metagraph.sh/api/v1/internal/subnet-identity-latest-hashes",
    ),
    "METAGRAPH_SUBNET_IDENTITY_SOURCE",
  );
  const map = new Map<number, unknown>();
  for (const row of (pg?.hashes as Row[]) || []) {
    const netuid = rowNetuid(row.netuid);
    if (netuid != null) map.set(netuid, row.identity_hash);
  }
  return map;
}

// D1 retirement (2026-07-16, item 10 of the D1->Postgres cleanup): D1's own
// `blocks` table was fully dropped in an earlier migration (#4772), so a
// `SELECT MAX(block_number) FROM blocks` against D1 always threw and this
// function always returned null -- silently, forever, not intermittently.
// Postgres's own `blocks` table is the live source now (already the
// flipped/current tier for the public /api/v1/blocks route via
// METAGRAPH_BLOCKS_SOURCE); this synthesizes an internal request the same
// "no client request to forward" way /api/v1/internal/compare-health does,
// since this call site is a cron-triggered internal helper, not a route.
// There is no D1 fallback left to attempt for this specific query -- the
// table it would have queried no longer exists in D1 at all -- so this
// simply returns null when Postgres is unavailable or the flag is off,
// same degrade as before, but now for a real reason instead of a guaranteed
// D1 miss.
async function latestBlockNumber(env: Env): Promise<number | null> {
  const pg = await tryPostgresTier(
    env,
    new Request("https://api.metagraph.sh/api/v1/internal/latest-block-number"),
    "METAGRAPH_BLOCKS_SOURCE",
  );
  const blockNumber = pg?.block_number as number | undefined;
  return Number.isSafeInteger(blockNumber) && (blockNumber as number) > 0
    ? (blockNumber as number)
    : null;
}

/**
 * #4832 gap-closure: mirror recordSubnetIdentityChanges' D1 write into
 * Postgres via the DATA_API service binding, called directly from
 * writeSubnetSnapshot (src/health-prober.ts) rather than through
 * workers/api.mjs's public proxy layer -- this runs from WITHIN the main
 * Worker's own hourly cron tick, a pure internal RPC hop, not a public-
 * internet crossing (unlike the other three #4832 sync routes, which are
 * driven by external GitHub Actions workflows and therefore cross the
 * public internet through the proxy). Best-effort: never throws, and a
 * failure here must never block the D1 write above (the primary contract)
 * or the rest of writeSubnetSnapshot's own work.
 */
export async function syncSubnetIdentityToPostgres(
  env: Env,
  { profiles }: { profiles?: Row[] } = {},
): Promise<Row> {
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
 * Diff profiles.json native_identity against the last stored hash per netuid.
 * D1 write retired (2026-07-16, item 8 of the D1->Postgres cleanup):
 * syncSubnetIdentityToPostgres (called right after this, from
 * writeSubnetSnapshot) is the real, working writer -- this function's own D1
 * INSERT had never successfully appended a single row to production D1
 * (confirmed via direct `wrangler d1 execute`, both before and after a live
 * cron tick -- see wrangler.jsonc's METAGRAPH_SUBNET_IDENTITY_SOURCE comment
 * for the full writeup). This now only reads D1's (frozen, from here on)
 * last-known hashes to report how many profiles' identity fields look
 * changed against that baseline -- writeSubnetSnapshot's own `identity_history`
 * return value -- without writing anything back.
 */
export async function recordSubnetIdentityChanges(
  env: Env,
  { profiles, now = Date.now() }: { profiles?: Row[]; now?: number } = {},
): Promise<Row> {
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return { recorded: false, reason: "unavailable" };
  }
  let latestByNetuid: Map<number, unknown>;
  try {
    latestByNetuid = await latestIdentityHashes(env);
  } catch (error) {
    // #4832 gap-closure follow-up: a swallowed read error here dark-served
    // the identity-history diff for an unknown stretch before anyone
    // noticed -- same failure class d1All was originally hardened against.
    console.error(
      "[recordSubnetIdentityChanges]",
      String((error as Error)?.message ?? error),
    );
    return { recorded: false, reason: "read_failed" };
  }
  const blockNumber = await latestBlockNumber(env);
  let changed = 0;
  for (const profile of profiles) {
    if (!Number.isInteger(profile?.netuid)) continue;
    const netuid = profile.netuid as number;
    const snapshot = identitySnapshotFromProfile(profile);
    if (!snapshot) continue;
    const hash = await identityHash(snapshot);
    if (latestByNetuid.get(netuid) === hash) continue;
    changed += 1;
    latestByNetuid.set(netuid, hash);
  }
  return {
    recorded: true,
    rows: changed,
    block_number: blockNumber,
    observed_at: now,
  };
}

export async function loadSubnetIdentityHistory(
  d1: D1Runner,
  netuid: unknown,
  {
    limit,
    offset,
    cursor,
  }: {
    limit?: string | number | null;
    offset?: string | number | null;
    cursor?: unknown;
  } = {},
): Promise<Row> {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params: unknown[] = [netuid];
  let sql = `SELECT ${READ_COLUMNS} FROM subnet_identity_history WHERE netuid = ?`;
  if (useCursor) {
    sql += " AND (observed_at, id) < (?, ?)";
    params.push((cur as number[])[0], (cur as number[])[1]);
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

export async function loadPreviouslyKnownAs(
  d1: D1Runner,
  netuid: unknown,
  currentName: unknown,
): Promise<string[]> {
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
export function deriveNetuidGroupedAliases(
  rows: Row[] | null | undefined,
  entries: Row[] | null | undefined,
): Map<number, string[]> {
  const currentByNetuid = new Map<number, unknown>(
    (entries || [])
      .filter((entry) => Number.isInteger(entry?.netuid))
      .map((entry) => [
        entry.netuid as number,
        entry.native_name ?? entry.name ?? null,
      ]),
  );
  const grouped = new Map<number, Row[]>();
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
  const out = new Map<number, string[]>();
  for (const [netuid, list] of grouped) {
    const names = derivePreviouslyKnownAs(list, currentByNetuid.get(netuid));
    if (names.length) out.set(netuid, names);
  }
  return out;
}

export async function loadPreviouslyKnownAsForNetuids(
  d1: D1Runner,
  entries: Row[] | null | undefined,
): Promise<Map<number, string[]>> {
  const items = entries || [];
  const netuids = items
    .map((entry) => entry?.netuid)
    .filter((netuid): netuid is number => Number.isInteger(netuid));
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
