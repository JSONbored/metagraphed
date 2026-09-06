'use strict';

// src/metagraphed-client.ts
var MetagraphedError = class extends Error {
  status;
  code;
  envelope;
  constructor(message, status, code, envelope) {
    super(message);
    this.name = "MetagraphedError";
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
};
function isErrorEnvelope(body) {
  return typeof body === "object" && body !== null && body.ok === false;
}
async function readJsonBody(response) {
  const text = await response.text();
  if (!text) {
    return void 0;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new MetagraphedError(
      `Response body was not valid JSON (status ${response.status})`,
      response.status
    );
  }
}
function resolveSignal(signal, timeoutMs) {
  if (signal) {
    return signal;
  }
  return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : void 0;
}
async function metagraphedFetch(path, options = {}) {
  const {
    baseUrl = "https://api.metagraph.sh",
    pathParams,
    query,
    timeoutMs = 3e4,
    signal,
    ...init
  } = options;
  const resolvedPath = interpolatePath(
    String(path),
    pathParams
  );
  const url = new URL(resolvedPath, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== void 0 && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    ...init,
    method: "GET",
    headers: {
      accept: "application/json",
      ...init.headers || {}
    },
    signal: resolveSignal(signal, timeoutMs)
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : void 0;
    throw new MetagraphedError(
      envelope?.error?.message ?? `GET ${url.pathname} failed with status ${response.status}`,
      response.status,
      envelope?.error?.code,
      envelope
    );
  }
  return body;
}
async function* metagraphedPaginate(path, options = {}) {
  const baseQuery = {
    ...options.query
  };
  let cursor = baseQuery.cursor;
  for (; ; ) {
    if (cursor !== void 0 && cursor !== null) {
      baseQuery.cursor = cursor;
    }
    const page = await metagraphedFetch(path, {
      ...options,
      query: baseQuery
    });
    yield page;
    const next = page?.meta?.pagination?.next_cursor;
    if (next === void 0 || next === null) {
      return;
    }
    cursor = next;
  }
}
async function metagraphedRpc(network, request, options = {}) {
  const {
    baseUrl = "https://api.metagraph.sh",
    timeoutMs = 3e4,
    signal,
    id = 1
  } = options;
  const url = new URL(`/rpc/v1/${encodeURIComponent(network)}`, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: request.method,
      params: request.params ?? []
    }),
    signal: resolveSignal(signal, timeoutMs)
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : void 0;
    throw new MetagraphedError(
      envelope?.error?.message ?? `RPC ${request.method} failed with status ${response.status}`,
      response.status,
      envelope?.error?.code,
      envelope
    );
  }
  const rpcError = body?.error;
  if (rpcError) {
    throw new MetagraphedError(
      typeof rpcError.message === "string" ? rpcError.message : "JSON-RPC error",
      response.status,
      rpcError.code === void 0 || rpcError.code === null ? void 0 : String(rpcError.code)
    );
  }
  return body?.result;
}
function interpolatePath(path, params) {
  if (!params) {
    return path;
  }
  let result = "";
  let i = 0;
  while (i < path.length) {
    const open = path.indexOf("{", i);
    if (open === -1) {
      result += path.slice(i);
      break;
    }
    const close = path.indexOf("}", open + 1);
    if (close === -1 || close === open + 1) {
      result += path.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    result += path.slice(i, open);
    const key = path.slice(open + 1, close);
    const value = params[key];
    if (value === void 0 || value === null) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    result += encodeURIComponent(String(value));
    i = close + 1;
  }
  return result;
}
var DEFAULT_CACHE_MAX_ENTRIES = 256;
function createLruEtagCache(maxEntries = DEFAULT_CACHE_MAX_ENTRIES) {
  const entries = /* @__PURE__ */ new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry !== void 0) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry;
    },
    set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === void 0) {
          break;
        }
        entries.delete(oldest);
      }
    }
  };
}
var RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
function resolveRetry(retry) {
  if (!retry) {
    return null;
  }
  const opts = typeof retry === "number" ? { retries: retry } : retry === true ? {} : retry;
  const retries = opts.retries ?? 2;
  if (retries <= 0) {
    return null;
  }
  return {
    retries,
    minDelayMs: opts.minDelayMs ?? 200,
    maxDelayMs: opts.maxDelayMs ?? 1e4,
    statuses: opts.statuses ?? RETRYABLE_STATUSES
  };
}
function retryDelayMs(response, attempt, retry) {
  const header = response ? response.headers.get("retry-after") : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(0, seconds) * 1e3, retry.maxDelayMs);
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), retry.maxDelayMs);
    }
  }
  const expo = Math.min(retry.minDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(expo * (0.5 + Math.random() / 2));
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MetagraphedError("Request aborted during retry backoff", 0));
    };
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new MetagraphedError("Request aborted during retry backoff", 0));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
function buildRequestUrl(path, baseUrl, pathParams, query) {
  const url = new URL(interpolatePath(path, pathParams), baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== void 0 && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}
function mergeRequestHeaders(clientHeaders, requestHeaders) {
  const merged = { accept: "application/json" };
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    merged[key.toLowerCase()] = value;
  }
  if (requestHeaders) {
    new Headers(requestHeaders).forEach((value, key) => {
      merged[key.toLowerCase()] = value;
    });
  }
  return merged;
}
function hashCacheKeyPart(value) {
  let high = 3735928559;
  let low = 1103547991;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high = Math.imul(high ^ high >>> 16, 2246822507) ^ Math.imul(low ^ low >>> 13, 3266489909);
  low = Math.imul(low ^ low >>> 16, 2246822507) ^ Math.imul(high ^ high >>> 13, 3266489909);
  return (low >>> 0).toString(16).padStart(8, "0") + (high >>> 0).toString(16).padStart(8, "0");
}
function buildEtagCacheKey(url, requestHeaders) {
  const headerKey = hashCacheKeyPart(
    Object.entries(requestHeaders).filter(([key]) => key !== "if-none-match").sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => key + ":" + value).join("\n")
  );
  return url.toString() + "\n" + headerKey;
}
function createMetagraphedClient(clientOptions = {}) {
  const baseUrl = clientOptions.baseUrl ?? "https://api.metagraph.sh";
  const fetchImpl = clientOptions.fetch ?? globalThis.fetch;
  const retry = resolveRetry(clientOptions.retry);
  const store = clientOptions.cache ? clientOptions.cache === true ? createLruEtagCache() : clientOptions.cache : null;
  async function request(path, options = {}) {
    const {
      baseUrl: requestBaseUrl,
      pathParams,
      query,
      timeoutMs = clientOptions.timeoutMs ?? 3e4,
      signal,
      headers,
      ...init
    } = options;
    const url = buildRequestUrl(
      String(path),
      requestBaseUrl ?? baseUrl,
      pathParams,
      query
    );
    let attempt = 0;
    let retriedUncachedNotModified = false;
    for (; ; ) {
      const requestHeaders = mergeRequestHeaders(clientOptions.headers, headers);
      const key = buildEtagCacheKey(url, requestHeaders);
      const cached = !retriedUncachedNotModified && store ? store.get(key) : void 0;
      if (cached) {
        requestHeaders["if-none-match"] = cached.etag;
      } else if (retriedUncachedNotModified) {
        delete requestHeaders["if-none-match"];
        delete requestHeaders["if-modified-since"];
      }
      let response;
      try {
        response = await fetchImpl(url, {
          ...init,
          method: "GET",
          headers: requestHeaders,
          signal: resolveSignal(signal, timeoutMs)
        });
      } catch (error) {
        if (signal && signal.aborted) {
          throw error;
        }
        if (retry && attempt < retry.retries) {
          await sleep(retryDelayMs(void 0, attempt, retry), signal);
          attempt += 1;
          continue;
        }
        throw error;
      }
      if (response.status === 304) {
        if (cached) {
          return cached.body;
        }
        if (retriedUncachedNotModified) {
          throw new MetagraphedError(
            "GET " + url.pathname + " returned 304 without a cached response",
            response.status
          );
        }
        retriedUncachedNotModified = true;
        continue;
      }
      if (retry && retry.statuses.includes(response.status) && attempt < retry.retries) {
        await sleep(retryDelayMs(response, attempt, retry), signal);
        attempt += 1;
        continue;
      }
      const body = await readJsonBody(response);
      if (!response.ok) {
        const envelope = isErrorEnvelope(body) ? body : void 0;
        throw new MetagraphedError(
          envelope?.error?.message ?? "GET " + url.pathname + " failed with status " + response.status,
          response.status,
          envelope?.error?.code,
          envelope
        );
      }
      if (store) {
        const etag = response.headers.get("etag");
        if (etag) {
          store.set(key, { etag, body });
        }
      }
      return body;
    }
  }
  async function* paginate(path, options = {}) {
    const baseQuery = {
      ...options.query
    };
    let cursor = baseQuery.cursor;
    for (; ; ) {
      if (cursor !== void 0 && cursor !== null) {
        baseQuery.cursor = cursor;
      }
      const page = await request(path, {
        ...options,
        query: baseQuery
      });
      yield page;
      const next = page?.meta?.pagination?.next_cursor;
      if (next === void 0 || next === null) {
        return;
      }
      cursor = next;
    }
  }
  async function fetchAll(path, options = {}) {
    const items = [];
    for await (const page of paginate(path, options)) {
      const data = page.data;
      if (Array.isArray(data)) {
        items.push(...data);
        continue;
      }
      if (typeof data !== "object" || data === null) {
        continue;
      }
      const record = data;
      const collection = page.meta?.pagination?.collection;
      if (typeof collection === "string" && Array.isArray(record[collection])) {
        items.push(...record[collection]);
        continue;
      }
      const arrays = Object.values(record).filter(
        (value) => Array.isArray(value)
      );
      if (arrays.length === 1) {
        items.push(...arrays[0]);
      }
    }
    return items;
  }
  function rpc(network, rpcRequest, options = {}) {
    return metagraphedRpc(network, rpcRequest, { baseUrl, ...options });
  }
  return {
    request,
    paginate,
    fetchAll,
    rpc,
    subnets: (query, options) => request("/api/v1/subnets", { ...options, query }),
    getSubnet: (netuid, options) => request("/api/v1/subnets/{netuid}", {
      ...options,
      pathParams: { netuid }
    }),
    providers: (query, options) => request("/api/v1/providers", { ...options, query }),
    getProvider: (slug, options) => request("/api/v1/providers/{slug}", {
      ...options,
      pathParams: { slug }
    }),
    surfaces: (query, options) => request("/api/v1/surfaces", { ...options, query }),
    endpoints: (query, options) => request("/api/v1/endpoints", { ...options, query }),
    candidates: (query, options) => request("/api/v1/candidates", { ...options, query }),
    profiles: (query, options) => request("/api/v1/profiles", { ...options, query }),
    health: (options) => request("/api/v1/health", { ...options })
  };
}
var QUERY_PARAMETER_ENUMS = {
  "/api/v1/accounts": {
    "format": ["json", "csv"],
    "sort": ["total_stake", "total_emission", "subnet_count", "uid_count", "validator_count", "stake_dominance", "last_active"]
  },
  "/api/v1/accounts/top-holders": {
    "format": ["json", "csv"],
    "sort": ["total_tao", "free_tao", "delegated_tao", "net_flow_7d", "net_flow_30d", "net_flow_90d"]
  },
  "/api/v1/accounts/{ss58}/axon-removals": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/counterparties": {
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/deregistrations": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/events": {
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/extrinsics": {
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/history": {
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/identity-history": {
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/prometheus": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/registrations": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/serving": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/stake-flow": {
    "direction": ["all", "in", "out"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/stake-moves": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/accounts/{ss58}/subnets/{netuid}/history": {
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/accounts/{ss58}/transfers": {
    "direction": ["all", "sent", "received"],
    "format": ["json", "csv"]
  },
  "/api/v1/accounts/{ss58}/weight-setters": {
    "window": ["7d", "30d"]
  },
  "/api/v1/agent-catalog": {
    "order": ["asc", "desc"],
    "sort": ["netuid", "callable_count", "completeness_score", "example_count"]
  },
  "/api/v1/blocks": {
    "format": ["json", "csv"]
  },
  "/api/v1/blocks/{ref}/events": {
    "format": ["json", "csv"]
  },
  "/api/v1/blocks/{ref}/extrinsics": {
    "format": ["json", "csv"]
  },
  "/api/v1/candidates": {
    "confidence": ["low", "medium", "high"],
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["confidence", "id", "kind", "name", "netuid", "provider", "state"],
    "state": ["schema-invalid", "schema-valid", "maintainer-review", "verified", "stale", "rejected"]
  },
  "/api/v1/chain-events": {
    "format": ["json", "csv"]
  },
  "/api/v1/chain/activity": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/alpha-volume": {
    "format": ["json", "csv"]
  },
  "/api/v1/chain/axon-removals": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/calls": {
    "format": ["json", "csv"],
    "group_by": ["module", "module_function"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/concentration/history": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/chain/concentration/subnets": {
    "lens": ["emission", "stake", "entity_emission", "entity_stake", "validator_stake"],
    "order": ["asc", "desc"],
    "sort": ["nakamoto_coefficient", "gini", "holders", "top_1pct_share", "total", "netuid"]
  },
  "/api/v1/chain/deregistrations": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/emission-pipeline": {
    "order": ["asc", "desc"],
    "sort": ["final_share", "emission_share", "weighted_share", "gated_share", "gate_delta", "distance_to_bar", "tao_in_emission", "excess_tao", "tao_total", "liquidity_fraction", "miner_burned", "netuid"]
  },
  "/api/v1/chain/fees": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/governance/emission-changes": {
    "kind": ["param", "subnet", "flow"]
  },
  "/api/v1/chain/holders": {
    "sort": ["top1_share", "top5_share", "top10_share", "top20_share", "holder_count", "total_alpha"]
  },
  "/api/v1/chain/prometheus": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/registrations": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/revenue-coverage": {
    "window": ["1d", "7d", "30d"]
  },
  "/api/v1/chain/serving": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/signers": {
    "format": ["json", "csv"],
    "sort": ["tx_count", "total_fee_tao"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/stake-flow": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/stake-moves": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/stake-transfers": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/stream": {
    "topics": ["blocks", "extrinsics", "chain_events", "account_events"]
  },
  "/api/v1/chain/subnet-lifecycle": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/chain/transfer-pairs": {
    "format": ["json", "csv"],
    "sort": ["volume", "count"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/transfers": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/turnover": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/chain/weights": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/chain/weights/setters": {
    "format": ["json", "csv"],
    "window": ["7d", "30d"]
  },
  "/api/v1/contracts": {
    "order": ["asc", "desc"],
    "sort": ["id", "path", "contract_version"]
  },
  "/api/v1/coverage-depth": {
    "agent_status": ["callable", "base-layer", "candidate", "needs-evidence", "blocked"],
    "blocker_level": ["none", "hard-blocked", "needs-review", "missing-data"],
    "format": ["json", "csv"],
    "order": ["asc", "desc"],
    "sort": ["agent_status", "blocker_level", "name", "netuid", "priority_score", "score", "tier"],
    "tier": ["agent-ready", "machine-usable", "candidate-review", "needs-evidence", "hard-blocked", "missing-interface"]
  },
  "/api/v1/curation": {
    "coverage_level": ["native-only", "manifested", "probed"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "order": ["asc", "desc"],
    "sort": ["coverage_level", "curation_level", "name", "netuid"]
  },
  "/api/v1/domains/{tag}/summary": {
    "tag": ["agents", "compute", "data", "finance", "inference", "media", "prediction", "privacy", "robotics", "science", "search", "security", "storage", "training"]
  },
  "/api/v1/economics": {
    "format": ["json", "csv"],
    "order": ["asc", "desc"],
    "registration_allowed": ["true", "false"],
    "sort": ["alpha_fdv_tao", "alpha_market_cap_tao", "alpha_price_change_1d", "alpha_price_change_1h", "alpha_price_change_1m", "alpha_price_change_7d", "alpha_price_tao", "block", "emission_share", "max_stake_alpha", "max_uids", "max_validators", "miner_count", "miner_readiness", "name", "netuid", "open_slots", "registration_cost_tao", "subnet_volume_tao", "total_stake_alpha", "validator_count"]
  },
  "/api/v1/economics/trends": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/endpoint-incidents": {
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "severity": ["critical", "warning", "info"],
    "sort": ["detected_at", "endpoint_id", "kind", "last_checked", "netuid", "provider", "severity", "state", "status"],
    "state": ["active", "resolved"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/endpoint-pools": {
    "kind": ["subtensor-rpc", "subtensor-wss", "archive"],
    "order": ["asc", "desc"],
    "sort": ["eligible_count", "endpoint_count", "id", "kind"]
  },
  "/api/v1/endpoints": {
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "known_status": ["true", "false"],
    "layer": ["bittensor-base", "data-provider", "docs-provider", "subnet-app"],
    "order": ["asc", "desc"],
    "pool_eligible": ["true", "false"],
    "publication_state": ["candidate", "verified", "monitored", "pool-eligible", "disabled", "rejected"],
    "sort": ["kind", "last_checked", "latency_ms", "layer", "netuid", "pool_eligible", "provider", "publication_state", "score", "status"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/evidence": {
    "order": ["asc", "desc"],
    "sort": ["claim", "source_url", "subject", "verified_at"]
  },
  "/api/v1/extrinsics": {
    "format": ["json", "csv"],
    "success": ["true", "false"]
  },
  "/api/v1/fixtures": {
    "order": ["asc", "desc"],
    "sort": ["captured_at", "netuid", "surface_id"]
  },
  "/api/v1/gaps": {
    "coverage_level": ["native-only", "manifested", "probed"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "order": ["asc", "desc"],
    "sort": ["coverage_level", "curation_level", "gap_count", "name", "netuid"]
  },
  "/api/v1/governance/config-changes": {
    "format": ["json", "csv"],
    "success": ["true", "false"]
  },
  "/api/v1/health": {
    "order": ["asc", "desc"],
    "sort": ["avg_latency_ms", "degraded_count", "failed_count", "last_checked", "last_ok", "name", "netuid", "ok_count", "status", "surface_count", "unknown_count"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/health/failure-reasons": {
    "window": ["7d", "30d", "90d", "180d"]
  },
  "/api/v1/health/history/{date}": {
    "classification": ["auth-required", "content-mismatch", "dead", "live", "rate-limited", "redirected", "timeout", "transient", "unsupported", "unsafe", "wrong-chain"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["classification", "kind", "last_checked", "last_ok", "latency_ms", "netuid", "provider", "status", "status_code", "surface_id", "verified_at"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/health/trends": {
    "window": ["7d", "30d"]
  },
  "/api/v1/incidents": {
    "order": ["asc", "desc"],
    "sort": ["downtime_ms", "incident_count", "netuid", "surface_id"],
    "window": ["7d", "30d"]
  },
  "/api/v1/network/tao-usd": {
    "window": ["1h", "24h", "7d", "30d"]
  },
  "/api/v1/profiles": {
    "confidence": ["low", "medium", "high"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "format": ["json", "csv"],
    "order": ["asc", "desc"],
    "profile_level": ["directory-only", "identity-partial", "identity-complete", "operational", "adapter-backed"],
    "sort": ["candidate_count", "completeness_score", "curation_level", "interface_count", "missing_critical_count", "name", "netuid", "operational_interface_count", "profile_level", "review_state"],
    "subnet_type": ["root", "application"]
  },
  "/api/v1/providers": {
    "authority": ["community", "official", "provider-claimed", "registry-observed"],
    "format": ["json", "csv"],
    "kind": ["data-provider", "docs-provider", "infrastructure-provider", "registry", "subnet-team"],
    "order": ["asc", "desc"],
    "sort": ["authority", "id", "kind", "name"]
  },
  "/api/v1/providers/{slug}/endpoints": {
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "known_status": ["true", "false"],
    "layer": ["bittensor-base", "data-provider", "docs-provider", "subnet-app"],
    "order": ["asc", "desc"],
    "pool_eligible": ["true", "false"],
    "publication_state": ["candidate", "verified", "monitored", "pool-eligible", "disabled", "rejected"],
    "sort": ["kind", "last_checked", "latency_ms", "layer", "netuid", "pool_eligible", "provider", "publication_state", "score", "status"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/registry/leaderboards": {
    "board": ["healthiest", "fastest-rpc", "most-complete", "most-enriched", "fastest-growing", "most-reliable", "open-slots", "cheapest-registration", "highest-emission", "validator-headroom", "biggest-alpha-gain-1d", "biggest-alpha-gain-7d"]
  },
  "/api/v1/review/adapter-candidates": {
    "candidate_api_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "format": ["json", "csv"],
    "operational_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "recommended_adapter_kind": ["custom-adapter", "data-artifact-adapter", "generic-openapi-or-custom", "stream-adapter"],
    "sort": ["candidate_api_count", "candidate_api_kinds", "curation_level", "name", "netuid", "operational_kinds", "operational_surface_count", "priority_score", "recommended_adapter_kind"]
  },
  "/api/v1/review/enrichment-evidence": {
    "direct_submission_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "evidence_action": ["submit-new-evidence", "verify-existing-evidence", "replace-stale-evidence", "review-existing-evidence", "maintainer-review-existing-evidence", "monitor"],
    "lane": ["direct-submission", "maintainer-review", "adapter-candidate", "monitoring-followup", "baseline-monitoring"],
    "missing_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["evidence_action", "lane", "name", "netuid", "priority_score"]
  },
  "/api/v1/review/enrichment-queue": {
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "direct_submission_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "evidence_action": ["submit-new-evidence", "verify-existing-evidence", "replace-stale-evidence", "review-existing-evidence", "maintainer-review-existing-evidence", "monitor"],
    "format": ["json", "csv"],
    "identity_level": ["none", "directory", "partial", "complete"],
    "lane": ["direct-submission", "maintainer-review", "adapter-candidate", "monitoring-followup", "baseline-monitoring"],
    "manual_review_required": ["true", "false"],
    "missing_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "profile_level": ["directory-only", "identity-partial", "identity-complete", "operational", "adapter-backed"],
    "sort": ["adapter_score", "candidate_count", "completeness_score", "curation_level", "endpoint_count", "evidence_action", "identity_level", "identity_surface_count", "lane", "name", "netuid", "operational_interface_count", "priority_score", "profile_level", "review_state", "stale_candidate_count", "surface_count", "verified_candidate_count"]
  },
  "/api/v1/review/enrichment-targets": {
    "auto_review_candidate": ["true", "false"],
    "evidence_action": ["submit-new-evidence", "verify-existing-evidence", "replace-stale-evidence", "review-existing-evidence", "maintainer-review-existing-evidence", "monitor"],
    "identity_level": ["none", "directory", "partial", "complete"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "lane": ["direct-submission", "maintainer-review", "adapter-candidate", "monitoring-followup", "baseline-monitoring"],
    "manual_review_required": ["true", "false"],
    "missing_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "profile_level": ["directory-only", "identity-partial", "identity-complete", "operational", "adapter-backed"],
    "sort": ["auto_review_candidate", "evidence_action", "identity_level", "kind", "lane", "manual_review_required", "name", "netuid", "priority_score", "profile_level", "submission_route", "target_action", "target_type"],
    "submission_route": ["direct-candidate-pr", "adapter-request", "maintainer-review", "status-report"],
    "target_action": ["submit-new-candidate", "replace-stale-candidate", "verify-existing-candidate", "review-existing-candidate", "adapter-review", "maintainer-review", "monitoring-followup"],
    "target_type": ["surface-candidate", "adapter-review", "maintainer-review", "monitoring-followup"]
  },
  "/api/v1/review/gaps": {
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "format": ["json", "csv"],
    "missing_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["candidate_count", "curation_level", "missing_kinds", "name", "netuid", "priority_score", "surface_count", "verified_candidate_count"]
  },
  "/api/v1/review/profile-completeness": {
    "confidence": ["low", "medium", "high"],
    "format": ["json", "csv"],
    "identity_level": ["none", "directory", "partial", "complete"],
    "identity_promotion_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "native_name_quality": ["chain", "placeholder", "empty"],
    "order": ["asc", "desc"],
    "profile_level": ["directory-only", "identity-partial", "identity-complete", "operational", "adapter-backed"],
    "sort": ["candidate_count", "completeness_score", "identity_level", "identity_promotion_kind_count", "identity_surface_count", "live_identity_candidate_kind_count", "missing_critical_count", "name", "native_identity_signal_count", "native_name_quality", "netuid", "priority_score", "profile_level", "stale_identity_candidate_kind_count"]
  },
  "/api/v1/rpc/endpoints": {
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "known_status": ["true", "false"],
    "layer": ["bittensor-base", "data-provider", "docs-provider", "subnet-app"],
    "order": ["asc", "desc"],
    "pool_eligible": ["true", "false"],
    "publication_state": ["candidate", "verified", "monitored", "pool-eligible", "disabled", "rejected"],
    "sort": ["kind", "last_checked", "latency_ms", "layer", "netuid", "pool_eligible", "provider", "publication_state", "score", "status"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/rpc/pools": {
    "kind": ["subtensor-rpc", "subtensor-wss", "archive"],
    "order": ["asc", "desc"],
    "sort": ["eligible_count", "endpoint_count", "id", "kind"]
  },
  "/api/v1/rpc/usage": {
    "window": ["7d", "30d"]
  },
  "/api/v1/runtime": {
    "format": ["json", "csv"]
  },
  "/api/v1/search": {
    "order": ["asc", "desc"],
    "sort": ["netuid", "slug", "title", "type"],
    "type": ["subnet", "surface", "provider"]
  },
  "/api/v1/search-index": {
    "order": ["asc", "desc"],
    "sort": ["netuid", "slug", "title", "type"],
    "type": ["subnet", "surface", "provider"]
  },
  "/api/v1/search/semantic": {
    "type": ["subnet", "surface", "provider"]
  },
  "/api/v1/source-snapshots": {
    "order": ["asc", "desc"],
    "sort": ["id", "kind", "path", "record_count"]
  },
  "/api/v1/subnets": {
    "coverage_level": ["native-only", "manifested", "probed"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "domain": ["agents", "compute", "data", "finance", "inference", "media", "prediction", "privacy", "robotics", "science", "search", "security", "storage", "training"],
    "format": ["json", "csv"],
    "order": ["asc", "desc"],
    "sort": ["block", "candidate_count", "coverage_level", "curation_level", "integration_readiness", "mechanism_count", "name", "netuid", "participant_count", "probed_surface_count", "status", "subnet_type", "surface_count", "tempo"],
    "status": ["active", "inactive"],
    "subnet_type": ["root", "application"]
  },
  "/api/v1/subnets/movers": {
    "format": ["json", "csv"],
    "sort": ["stake", "emission", "validators", "neurons"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/axon-removals": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/burn/history": {
    "window": ["24h", "7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/candidates": {
    "confidence": ["low", "medium", "high"],
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["confidence", "id", "kind", "name", "netuid", "provider", "state"],
    "state": ["schema-invalid", "schema-valid", "maintainer-review", "verified", "stale", "rejected"]
  },
  "/api/v1/subnets/{netuid}/concentration/history": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/deregistration-ranking/history": {
    "window": ["7d", "30d", "90d", "180d"]
  },
  "/api/v1/subnets/{netuid}/deregistrations": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/emission-pipeline/history": {
    "window": ["7d", "30d", "90d", "180d"]
  },
  "/api/v1/subnets/{netuid}/emission-split/history": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/endpoints": {
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "known_status": ["true", "false"],
    "layer": ["bittensor-base", "data-provider", "docs-provider", "subnet-app"],
    "order": ["asc", "desc"],
    "pool_eligible": ["true", "false"],
    "publication_state": ["candidate", "verified", "monitored", "pool-eligible", "disabled", "rejected"],
    "sort": ["kind", "last_checked", "latency_ms", "layer", "netuid", "pool_eligible", "provider", "publication_state", "score", "status"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/subnets/{netuid}/event-summary": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/events": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/evidence": {
    "order": ["asc", "desc"],
    "sort": ["claim", "source_url", "subject", "verified_at"]
  },
  "/api/v1/subnets/{netuid}/gaps": {
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "format": ["json", "csv"],
    "missing_kinds": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["candidate_count", "curation_level", "missing_kinds", "name", "netuid", "priority_score", "surface_count", "verified_candidate_count"]
  },
  "/api/v1/subnets/{netuid}/health": {
    "classification": ["auth-required", "content-mismatch", "dead", "live", "rate-limited", "redirected", "timeout", "transient", "unsupported", "unsafe", "wrong-chain"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "sort": ["classification", "kind", "last_checked", "last_ok", "latency_ms", "netuid", "provider", "status", "status_code", "surface_id", "verified_at"],
    "status": ["ok", "degraded", "failed", "unknown"]
  },
  "/api/v1/subnets/{netuid}/health/incidents": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/health/percentiles": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/history": {
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/subnets/{netuid}/hyperparameters/history": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/identity-history": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/lifecycle": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/metagraph": {
    "format": ["json", "csv"],
    "validator_permit": ["true"]
  },
  "/api/v1/subnets/{netuid}/miner-fairness": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/neurons/{uid}/history": {
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/subnets/{netuid}/ohlc": {
    "interval": ["1h", "1d"]
  },
  "/api/v1/subnets/{netuid}/owner-capture": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/performance/history": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/prometheus": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/registrations": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/revenue": {
    "window": ["1d", "7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/serving": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/stake-flow": {
    "direction": ["all", "in", "out"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/stake-moves": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/stake-quote": {
    "direction": ["stake", "unstake"]
  },
  "/api/v1/subnets/{netuid}/stake-transfers": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/surfaces": {
    "auth_required": ["true", "false"],
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "public_safe": ["true", "false"],
    "rate_limited": ["true", "false"],
    "sort": ["id", "kind", "name", "netuid", "provider"]
  },
  "/api/v1/subnets/{netuid}/trajectory": {
    "format": ["json", "csv"],
    "order": ["asc", "desc"],
    "sort": ["date", "completeness_score", "surface_count", "endpoint_count"]
  },
  "/api/v1/subnets/{netuid}/turnover": {
    "changes": ["true", "false"],
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/subnets/{netuid}/uptime": {
    "format": ["json", "csv"],
    "window": ["90d", "1y"]
  },
  "/api/v1/subnets/{netuid}/validator-economics/history": {
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/subnets/{netuid}/validators": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/weights": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/weights/setters": {
    "window": ["7d", "30d"]
  },
  "/api/v1/subnets/{netuid}/yield": {
    "format": ["json", "csv"]
  },
  "/api/v1/subnets/{netuid}/yield/history": {
    "format": ["json", "csv"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/sudo": {
    "format": ["json", "csv"],
    "success": ["true", "false"]
  },
  "/api/v1/surfaces": {
    "auth_required": ["true", "false"],
    "format": ["json", "csv"],
    "kind": ["archive", "dashboard", "data-artifact", "docs", "example", "openapi", "repo-registry", "sdk", "source-repo", "sse", "subnet-api", "subtensor-rpc", "subtensor-wss", "website"],
    "order": ["asc", "desc"],
    "public_safe": ["true", "false"],
    "rate_limited": ["true", "false"],
    "sort": ["id", "kind", "name", "netuid", "provider"]
  },
  "/api/v1/validators": {
    "format": ["json", "csv"],
    "sort": ["avg_validator_trust", "max_validator_trust", "stake_dominance", "subnet_count", "total_emission", "total_stake", "uid_count"]
  },
  "/api/v1/validators/economics": {
    "sort": ["earning_floor_cost_tao", "permit_floor_cost_tao", "permit_to_earning_multiple", "tao_inflow_per_day", "validator_headroom"]
  },
  "/api/v1/validators/{hotkey}/history": {
    "window": ["7d", "30d", "90d", "1y", "all"]
  },
  "/api/v1/validators/{hotkey}/nominators": {
    "basis": ["flow", "positions"],
    "format": ["json", "csv"],
    "sort": ["net_staked", "gross_staked", "last_activity"],
    "window": ["7d", "30d", "90d"]
  },
  "/api/v1/{network}/accounts/{ss58}/balance": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/accounts/{ss58}/children": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/accounts/{ss58}/parents": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/accounts/{ss58}/root-claim": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks/summary": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks/{ref}": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks/{ref}/chain-events": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks/{ref}/events": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/blocks/{ref}/extrinsics": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/chain-events": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/chain-events/stats": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/chain/activity": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/alpha-volume": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/chain/burn": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/chain/calls": {
    "format": ["json", "csv"],
    "group_by": ["module", "module_function"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/deregistrations": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/fees": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/prometheus": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/registrations": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/serving": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/signers": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "sort": ["tx_count", "total_fee_tao"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/stake-flow": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/stake-moves": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/stake-transfers": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/transfer-pairs": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "sort": ["volume", "count"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/transfers": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/weights": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/chain/weights/setters": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "window": ["7d", "30d"]
  },
  "/api/v1/{network}/coverage": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/crowdloans": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/crowdloans/{crowdloan_id}": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/economics": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "order": ["asc", "desc"],
    "registration_allowed": ["true", "false"],
    "sort": ["alpha_fdv_tao", "alpha_market_cap_tao", "alpha_price_change_1d", "alpha_price_change_1h", "alpha_price_change_1m", "alpha_price_change_7d", "alpha_price_tao", "block", "emission_share", "max_stake_alpha", "max_uids", "max_validators", "miner_count", "miner_readiness", "name", "netuid", "open_slots", "registration_cost_tao", "subnet_volume_tao", "total_stake_alpha", "validator_count"]
  },
  "/api/v1/{network}/evm/address/{h160}": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/export/chain-events": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/extrinsics": {
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "success": ["true", "false"]
  },
  "/api/v1/{network}/extrinsics/{hash}": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/network/parameters": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/network/randomness": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/networks": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/search/resolve": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/subnets": {
    "coverage_level": ["native-only", "manifested", "probed"],
    "curation_level": ["native", "candidate-discovered", "community-seeded", "machine-verified", "maintainer-reviewed", "adapter-backed"],
    "domain": ["agents", "compute", "data", "finance", "inference", "media", "prediction", "privacy", "robotics", "science", "search", "security", "storage", "training"],
    "format": ["json", "csv"],
    "network": ["finney", "mainnet", "test", "testnet"],
    "order": ["asc", "desc"],
    "sort": ["block", "candidate_count", "coverage_level", "curation_level", "integration_readiness", "mechanism_count", "name", "netuid", "participant_count", "probed_surface_count", "status", "subnet_type", "surface_count", "tempo"],
    "status": ["active", "inactive"],
    "subnet_type": ["root", "application"]
  },
  "/api/v1/{network}/subnets/{netuid}": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/subnets/{netuid}/burn": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/subnets/{netuid}/lease": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/subnets/{netuid}/recycled": {
    "network": ["finney", "mainnet", "test", "testnet"]
  },
  "/api/v1/{network}/sudo/key": {
    "network": ["finney", "mainnet", "test", "testnet"]
  }
};

exports.MetagraphedError = MetagraphedError;
exports.QUERY_PARAMETER_ENUMS = QUERY_PARAMETER_ENUMS;
exports.createLruEtagCache = createLruEtagCache;
exports.createMetagraphedClient = createMetagraphedClient;
exports.metagraphedFetch = metagraphedFetch;
exports.metagraphedPaginate = metagraphedPaginate;
exports.metagraphedRpc = metagraphedRpc;
