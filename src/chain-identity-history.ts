// Network-wide subnet-identity-change feed: the most-recent SubnetIdentitiesV3
// changes aggregated across EVERY subnet (newest first), a capped feed rather than
// a per-subnet timeline. The network analog of the per-subnet
// /api/v1/subnets/{netuid}/identity-history route (src/subnet-identity-history.ts)
// and the identity-change companion to the other chain/* aggregates. Each entry is
// shaped identically to the per-subnet route via the shared
// formatIdentityHistoryEntry, plus the `netuid` it belongs to so a change is
// attributable to its subnet. Pure + injectable for tests; the Worker does the
// Postgres read + envelope (D1 fully eliminated, 2026-07-16 -- the pure builder
// below is called directly with an empty array on a Postgres miss/outage,
// never a live store read). Null-safe: a non-array/empty read yields a
// schema-stable empty feed and never throws.

import {
  READ_COLUMNS,
  formatIdentityHistoryEntry,
} from "./subnet-identity-history.ts";
import {
  FEED_PAGINATION,
  clampLimit,
  clampToolLimit,
} from "../workers/request-params.ts";

// Page-size ceiling, single-sourced in route-limits.ts so the contract's
// published `maximum` and this route's enforcement cannot drift (#9127).
import {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "./route-limits.ts";
export {
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
};

// Clamp a raw limit into [1, MAX], falling back to the default when absent/blank/
// non-finite. The Worker handler validates + REJECTS an out-of-range value with a
// 400 (parseLimitParam); this keeps the pure loader's contract aligned when a
// direct caller (e.g. the MCP tool) passes a plain number.
// The shared tool page-size rule (workers/request-params.ts), coerced first
// because this feed takes its limit straight off a raw argument.
function clampFeedLimit(raw: unknown): number {
  return clampToolLimit(
    Number(raw),
    CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
    CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
  );
}

// Coerce a raw D1 netuid cell to a valid subnet id or null. Guards the coercion the
// way chain-performance does: a blank / whitespace-only / non-integer / negative
// cell must not count as subnet 0.
function toNetuid(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const netuid = Number(raw);
  return Number.isInteger(netuid) && netuid >= 0 ? netuid : null;
}

export interface ChainIdentityHistoryResult {
  schema_version: 1;
  count: number;
  subnet_count: number;
  changes: Array<Record<string, unknown>>;
}

// Shape EVERY subnet's identity-change rows into the network feed: map each row
// through the shared per-subnet formatter (so an entry is byte-identical to the
// per-subnet route), attach its `netuid`, keep them most-recent-first (the loader
// already reads block_number DESC, netuid ASC — a stable tiebreak), cap to `limit`,
// and report the distinct subnet_count the emitted feed spans. Null-safe on a
// non-array/empty read → a schema-stable empty feed.
export function buildChainIdentityHistory(
  rows: Array<Record<string, unknown>> | null | undefined,
  { limit }: { limit?: unknown } = {},
): ChainIdentityHistoryResult {
  const cap = clampFeedLimit(limit);
  const list = Array.isArray(rows) ? rows : [];
  const changes: Array<Record<string, unknown>> = [];
  const netuids = new Set<number>();
  for (const row of list) {
    if (changes.length >= cap) break;
    const entry: Record<string, unknown> | null =
      formatIdentityHistoryEntry(row);
    if (!entry) continue;
    const netuid = toNetuid(row?.netuid);
    if (netuid !== null) netuids.add(netuid);
    // Spread the shared entry first so the sanitized `netuid` (via toNetuid) is
    // authoritative and can never be clobbered if the formatter ever emits one.
    changes.push({ ...entry, netuid });
  }
  return {
    schema_version: 1,
    count: changes.length,
    subnet_count: netuids.size,
    changes,
  };
}

/**
 * The network-wide identity feed, newest first, from the LIVE store (#10773).
 *
 * The twin of `loadSubnetIdentityHistory` for /api/v1/chain/identity-history
 * and its MCP + GraphQL surfaces. It did not exist because nothing could call
 * it: `METAGRAPH_SUBNET_IDENTITY_SOURCE` was retired while
 * `subnet_identity_history` had no writer at all, so #10190 removed the tier
 * read as unreachable and every surface fell through to the frozen lakehouse
 * export. The writer landed on 2026-08-11 (#10740 / #10762 and
 * metagraphed-infra#444) and the reader was never repointed -- the lane wrote
 * 248 rows at 13:15Z while all three surfaces still served 2026-07-31.
 *
 * ORDER MATCHES THE COLD TIER'S, deliberately -- `block_number DESC, netuid
 * ASC, id DESC`, the same total order `loadChainIdentityHistoryColdTier` uses.
 * The two legs answer the same question and a caller cannot tell which one
 * did; feeds that disagreed on ordering would surface as rows shuffling
 * whenever the live store went cold.
 *
 * `netuid` leads the column list because the network feed carries it and the
 * per-subnet timeline does not -- the same split the cold tier makes, and the
 * reason this selects `READ_COLUMNS` rather than restating it.
 */
export async function loadChainIdentityHistory(
  runner: (
    sql: string,
    params: unknown[],
  ) => Promise<Record<string, unknown>[]>,
  { limit }: { limit?: string | number | null } = {},
): Promise<ChainIdentityHistoryResult> {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const rows = await runner(
    `SELECT netuid, ${READ_COLUMNS} FROM subnet_identity_history` +
      " ORDER BY block_number DESC, netuid ASC, id DESC LIMIT ?",
    [lim],
  );
  return buildChainIdentityHistory(rows, { limit: lim });
}
