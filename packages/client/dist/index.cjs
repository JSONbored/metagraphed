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

exports.MetagraphedError = MetagraphedError;
exports.createLruEtagCache = createLruEtagCache;
exports.createMetagraphedClient = createMetagraphedClient;
exports.metagraphedFetch = metagraphedFetch;
exports.metagraphedPaginate = metagraphedPaginate;
exports.metagraphedRpc = metagraphedRpc;
