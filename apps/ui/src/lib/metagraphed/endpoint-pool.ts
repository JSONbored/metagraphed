import type { Endpoint, RpcPool } from "./types";

export type PoolEligibility = "proxy-enabled" | "pool-member" | "archive-capable" | "unassigned";

const ARCHIVE_KINDS = new Set(["archive", "wss-archive", "rpc-archive"]);
const EMPTY_POOLS_BY_ID = new Map<string, RpcPool>();

/**
 * Derive a single pool-eligibility label for an endpoint by joining its
 * `pool`/`pool_eligible`/`archive` flags against the RPC pools list.
 *
 * Order of precedence (highest → lowest):
 *   proxy-enabled   — pool has `proxy_enabled: true` and endpoint is a member
 *   pool-member     — endpoint references a pool id
 *   archive-capable — endpoint kind/flag signals archive support
 *   unassigned      — none of the above
 */
export function indexPoolsById(pools: RpcPool[] = []): ReadonlyMap<string, RpcPool> {
  return new Map(pools.map((p) => [p.id, p]));
}

export function endpointEligibility(
  e: Endpoint,
  poolsById: ReadonlyMap<string, RpcPool> = EMPTY_POOLS_BY_ID,
): PoolEligibility {
  const poolId = (e.pool ?? null) as string | null;
  const pool = poolId ? poolsById.get(poolId) : null;
  if (pool?.proxy_enabled) return "proxy-enabled";
  if (poolId || e.pool_eligible) return "pool-member";
  const kind = String(e.kind ?? "").toLowerCase();
  if (e.archive || ARCHIVE_KINDS.has(kind)) return "archive-capable";
  return "unassigned";
}

export const ELIGIBILITY_LABEL: Record<PoolEligibility, string> = {
  "proxy-enabled": "Proxy",
  "pool-member": "Pool",
  "archive-capable": "Archive",
  unassigned: "Unassigned",
};

export const ELIGIBILITY_TONE: Record<PoolEligibility, string> = {
  "proxy-enabled": "border-curation-pilot/40 bg-curation-pilot/10 text-curation-pilot",
  "pool-member": "border-curation-machine/40 bg-curation-machine/10 text-curation-machine",
  "archive-capable": "border-curation-verified/40 bg-curation-verified/10 text-curation-verified",
  unassigned: "border-border bg-paper text-ink-muted",
};

/**
 * Group endpoints by a canonical "category" for the kind chip rail.
 * Keeps the list short and meaningful even when the registry exposes
 * many adjacent kinds (e.g. rpc / rpc-archive collapse into RPC).
 */
export type EndpointCategory = "rpc" | "wss" | "api" | "sse" | "data" | "other";

export function endpointCategory(kind?: string | null): EndpointCategory {
  const k = String(kind ?? "").toLowerCase();
  if (!k) return "other";
  if (k.includes("wss") || k === "ws") return "wss";
  if (k.includes("rpc")) return "rpc";
  if (k === "sse" || k.includes("stream")) return "sse";
  if (k === "data" || k.includes("artifact") || k.includes("dataset")) return "data";
  if (k === "api" || k.includes("http") || k.includes("rest") || k.includes("grpc")) return "api";
  return "other";
}

export const CATEGORY_LABEL: Record<EndpointCategory, string> = {
  rpc: "RPC",
  wss: "WSS",
  api: "API",
  sse: "SSE",
  data: "Data",
  other: "Other",
};
