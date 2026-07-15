/**
 * Static reference copy for the `/rpc` docs page (#3515).
 *
 * Paths, networks, allowlists, and limits mirror
 * `workers/request-handlers/rpc-proxy.mjs` + `workers/config.mjs` — keep them
 * in sync when the Worker RPC contract changes. The UI cannot import Worker
 * `.mjs` modules, so these are intentional literals.
 *
 * @see https://github.com/JSONbored/metagraphed/issues/3515
 */

/** Keep aligned with MAX_RPC_BODY_BYTES in workers/config.mjs */
export const RPC_DOCS_MAX_BODY_BYTES = 64 * 1024;

/** Keep aligned with MAX_STATE_QUERY_RESPONSE_BYTES in workers/config.mjs */
export const RPC_DOCS_MAX_STATE_QUERY_RESPONSE_BYTES = 256 * 1024;

/** Keep aligned with MAX_STATE_QUERY_KEYS_PAGE_SIZE in workers/config.mjs */
export const RPC_DOCS_MAX_STATE_QUERY_KEYS_PAGE_SIZE = 250;

/** Keep aligned with RPC_RATE_LIMIT in workers/request-handlers/rpc-proxy.mjs */
export const RPC_DOCS_RATE_LIMIT_REQUESTS = 100;
export const RPC_DOCS_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Keep aligned with STATE_QUERY_RATE_LIMIT in workers/request-handlers/rpc-proxy.mjs */
export const RPC_DOCS_STATE_QUERY_RATE_LIMIT_REQUESTS = 20;
export const RPC_DOCS_STATE_QUERY_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Keep aligned with RPC_MAX_ATTEMPTS in workers/request-handlers/rpc-proxy.mjs */
export const RPC_DOCS_MAX_ATTEMPTS = 3;

/** Keep aligned with RPC_PROXY_POOLS keys in workers/request-handlers/rpc-proxy.mjs */
export const RPC_DOCS_NETWORKS = ["finney", "test"] as const;

export type RpcDocsNetwork = (typeof RPC_DOCS_NETWORKS)[number];

export const RPC_PROXY_PATH_TEMPLATE = "/rpc/v1/{network}";

export const RPC_POOLS_PATH = "/api/v1/rpc/pools";
export const RPC_ENDPOINTS_PATH = "/api/v1/rpc/endpoints";
export const RPC_USAGE_PATH = "/api/v1/rpc/usage";

/** Keep aligned with SAFE_RPC_METHODS in workers/config.mjs */
export const RPC_DOCS_SAFE_METHODS = [
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
] as const;

/** Keep aligned with SAFE_RPC_STATE_QUERY_METHODS in workers/config.mjs */
export const RPC_DOCS_STATE_QUERY_METHODS = ["state_getStorage", "state_getKeysPaged"] as const;

/** Keep aligned with DENIED_RPC_PREFIXES in workers/config.mjs */
export const RPC_DOCS_DENIED_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
] as const;

export type RpcApiSurfaceDoc = {
  method: string;
  path: string;
  summary: string;
  notes: string;
};

/** Catalog surfaces that pair with the live HTTP proxy. */
export const RPC_API_SURFACES: readonly RpcApiSurfaceDoc[] = [
  {
    method: "POST",
    path: RPC_PROXY_PATH_TEMPLATE,
    summary: "Read-only JSON-RPC reverse proxy",
    notes:
      "Network segment is finney (mainnet) or test (testnet). Single JSON-RPC object only — no batches, no HTTP WebSocket upgrade.",
  },
  {
    method: "GET",
    path: RPC_POOLS_PATH,
    summary: "Proxy pool roster + live eligibility",
    notes:
      "Serves rpc/pools.json with probe-derived health overlaid from KV so dead upstreams show as ineligible.",
  },
  {
    method: "GET",
    path: RPC_ENDPOINTS_PATH,
    summary: "Base-layer Subtensor RPC/WSS registry",
    notes:
      "Filterable catalog (kind, layer, status, provider, pool_eligible, latency). Pair with the live table on /endpoints.",
  },
  {
    method: "GET",
    path: RPC_USAGE_PATH,
    summary: "Proxy usage analytics",
    notes:
      "Request volume, latency p50/p95, failover/error/cache rates, per-endpoint and per-network distribution. ?window=7d|30d.",
  },
] as const;

export type RpcLimitRow = {
  label: string;
  value: string;
  detail: string;
};

/** Format a byte budget for the limits table (e.g. 65536 → "64 KiB"). */
export function formatRpcByteBudget(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}

export function buildRpcLimitRows(): RpcLimitRow[] {
  return [
    {
      label: "Rate limit",
      value: `${RPC_DOCS_RATE_LIMIT_REQUESTS} / ${RPC_DOCS_RATE_LIMIT_WINDOW_SECONDS}s`,
      detail:
        "Per-client IP on POST /rpc/v1/* (429 + retry-after). Shared binding policy with GraphQL.",
    },
    {
      label: "State-query rate",
      value: `${RPC_DOCS_STATE_QUERY_RATE_LIMIT_REQUESTS} / ${RPC_DOCS_STATE_QUERY_RATE_LIMIT_WINDOW_SECONDS}s`,
      detail:
        "Additional budget for state_getStorage / state_getKeysPaged — does not starve ordinary chain/system reads.",
    },
    {
      label: "Max POST body",
      value: formatRpcByteBudget(RPC_DOCS_MAX_BODY_BYTES),
      detail: "HTTP request body size cap for the read-only proxy.",
    },
    {
      label: "Max state-query response",
      value: formatRpcByteBudget(RPC_DOCS_MAX_STATE_QUERY_RESPONSE_BYTES),
      detail: "Decoded upstream body cap for state-query methods after fetch.",
    },
    {
      label: "state_getKeysPaged page",
      value: String(RPC_DOCS_MAX_STATE_QUERY_KEYS_PAGE_SIZE),
      detail: "Caller-supplied count is clamped server-side (not rejected).",
    },
    {
      label: "Failover attempts",
      value: String(RPC_DOCS_MAX_ATTEMPTS),
      detail: "Per request across the health-ordered pool before surfacing upstream failure.",
    },
  ];
}

export function rpcProxyPath(network: RpcDocsNetwork): string {
  return `/rpc/v1/${network}`;
}

export function buildRpcCurlExample(apiBase: string, network: RpcDocsNetwork = "finney"): string {
  const base = apiBase.replace(/\/$/, "");
  const url = `${base}${rpcProxyPath(network)}`;
  return [
    `curl -s '${url}' \\`,
    `  -X POST -H 'content-type: application/json' \\`,
    `  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader","params":[]}'`,
  ].join("\n");
}

/** Expected catalog surface count — guards accidental drift. */
export const RPC_API_SURFACE_COUNT = 4;

/** Expected safe method count (excluding state-query allowlist). */
export const RPC_DOCS_SAFE_METHOD_COUNT = 11;
