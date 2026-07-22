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
// never a live D1 read). Null-safe: a non-array/empty read yields a
// schema-stable empty feed and never throws.

import { formatIdentityHistoryEntry } from "./subnet-identity-history.ts";

// Analytics-feed limit convention copied from the chain-calls / chain-signers feeds
// (parseLimitParam with defaultLimit: 50, maxLimit: 200 — the recent-events feed
// sizing): default 50 changes, capped at 200.
export const CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT = 50;
export const CHAIN_IDENTITY_HISTORY_LIMIT_MAX = 200;

// Clamp a raw limit into [1, MAX], falling back to the default when absent/blank/
// non-finite. The Worker handler validates + REJECTS an out-of-range value with a
// 400 (parseLimitParam); this keeps the pure loader's contract aligned when a
// direct caller (e.g. the MCP tool) passes a plain number.
function clampFeedLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT;
  const floored = Math.floor(n);
  if (floored < 1) return CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT;
  return Math.min(floored, CHAIN_IDENTITY_HISTORY_LIMIT_MAX);
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
