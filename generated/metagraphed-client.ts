/**
 * This file was auto-generated from public/metagraph/openapi.json.
 * Do not make direct changes to the file.
 */

import type { components, paths } from "metagraphed-contract";

export type ApiPaths = paths;
export type ApiComponents = components;
export type ApiSchema<Name extends keyof components["schemas"]> =
  components["schemas"][Name];

export type SuccessEnvelope<Data = unknown> = Omit<
  components["schemas"]["SuccessEnvelope"],
  "data"
> & {
  data: Data;
};

export type ErrorEnvelope = components["schemas"]["ErrorEnvelope"];
export type ApiEnvelope<Data = unknown> = SuccessEnvelope<Data> | ErrorEnvelope;

export type SubnetIndexEntry = components["schemas"]["SubnetIndexEntry"];
export type SubnetDetail = components["schemas"]["SubnetDetail"];
export type Surface = components["schemas"]["Surface"];
export type CandidateSurface = components["schemas"]["CandidateSurface"];
export type EndpointResource = components["schemas"]["EndpointResource"];
export type EndpointPool = components["schemas"]["RpcPool"];
export type Provider = components["schemas"]["Provider"];
export type HealthSurface = components["schemas"]["HealthSurface"];
export type HealthSummary = components["schemas"]["HealthSummaryArtifact"];
export type EvidenceClaim = components["schemas"]["EvidenceClaim"];
export type AdapterSnapshot = components["schemas"]["AdapterArtifact"];

export type ApiPath = keyof paths;
export type GetOperation<Path extends ApiPath> =
  paths[Path] extends { get: infer Operation } ? Operation : never;
export type QueryParams<Path extends ApiPath> =
  GetOperation<Path> extends { parameters: { query?: infer Query } }
    ? Query
    : never;
export type PathParams<Path extends ApiPath> =
  GetOperation<Path> extends { parameters: { path?: infer Params } }
    ? Params
    : never;
export type JsonResponse<Path extends ApiPath> =
  GetOperation<Path> extends {
    responses: {
      200: {
        content: {
          "application/json": infer Body;
        };
      };
    };
  }
    ? Body
    : never;

export interface MetagraphedFetchOptions<Path extends ApiPath>
  extends Omit<RequestInit, "method" | "body"> {
  baseUrl?: string;
  pathParams?: PathParams<Path>;
  query?: QueryParams<Path>;
  /** Abort the request after this many ms (default 30000). Pass 0 to disable. An explicit `signal` takes precedence. */
  timeoutMs?: number;
}

/** Thrown on a non-2xx response (or a JSON-RPC error). Carries the HTTP status, the API error code, and the parsed error envelope. Mirrors the Python client's MetagraphedError. */
export class MetagraphedError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly envelope: ErrorEnvelope | undefined;
  constructor(
    message: string,
    status: number,
    code?: string,
    envelope?: ErrorEnvelope,
  ) {
    super(message);
    this.name = "MetagraphedError";
    this.status = status;
    this.code = code;
    this.envelope = envelope;
  }
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { ok?: unknown }).ok === false
  );
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new MetagraphedError(
      `Response body was not valid JSON (status ${response.status})`,
      response.status,
    );
  }
}

function resolveSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (signal) {
    return signal;
  }
  return timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
}

/**
 * Fetch a typed GET endpoint. Resolves to the success envelope on 2xx and
 * THROWS a MetagraphedError (carrying status + error code + envelope) on any
 * non-2xx, so a resolved value is always a success.
 */
export async function metagraphedFetch<Path extends ApiPath>(
  path: Path,
  options: MetagraphedFetchOptions<Path> = {},
): Promise<JsonResponse<Path>> {
  const {
    baseUrl = "https://api.metagraph.sh",
    pathParams,
    query,
    timeoutMs = 30000,
    signal,
    ...init
  } = options;
  const resolvedPath = interpolatePath(
    String(path),
    pathParams as Record<string, string | number> | undefined,
  );
  const url = new URL(resolvedPath, baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    ...init,
    method: "GET",
    headers: {
      accept: "application/json",
      ...(init.headers || {}),
    },
    signal: resolveSignal(signal, timeoutMs),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : undefined;
    throw new MetagraphedError(
      envelope?.error?.message ??
        `GET ${url.pathname} failed with status ${response.status}`,
      response.status,
      envelope?.error?.code,
      envelope,
    );
  }
  return body as JsonResponse<Path>;
}

/**
 * Follow cursor pagination for a list endpoint, yielding each page's success
 * envelope until meta.pagination.next_cursor is exhausted.
 */
export async function* metagraphedPaginate<Path extends ApiPath>(
  path: Path,
  options: MetagraphedFetchOptions<Path> = {},
): AsyncGenerator<JsonResponse<Path>, void, unknown> {
  const baseQuery: Record<string, unknown> = {
    ...(options.query as Record<string, unknown> | undefined),
  };
  let cursor: unknown = baseQuery.cursor;
  for (;;) {
    if (cursor !== undefined && cursor !== null) {
      baseQuery.cursor = cursor;
    }
    const page = await metagraphedFetch(path, {
      ...options,
      query: baseQuery as unknown as QueryParams<Path>,
    });
    yield page;
    const next = (
      page as { meta?: { pagination?: { next_cursor?: unknown } } }
    )?.meta?.pagination?.next_cursor;
    if (next === undefined || next === null) {
      return;
    }
    cursor = next;
  }
}

export interface JsonRpcRequest {
  method: string;
  params?: unknown[];
}

export interface MetagraphedRpcOptions {
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  id?: number | string;
}

/**
 * Call the read-only Subtensor RPC proxy (POST /rpc/v1/<network>) and return the
 * JSON-RPC result. Throws MetagraphedError on an HTTP or JSON-RPC-level error.
 */
export async function metagraphedRpc<Result = unknown>(
  network: string,
  request: JsonRpcRequest,
  options: MetagraphedRpcOptions = {},
): Promise<Result> {
  const {
    baseUrl = "https://api.metagraph.sh",
    timeoutMs = 30000,
    signal,
    id = 1,
  } = options;
  const url = new URL(`/rpc/v1/${encodeURIComponent(network)}`, baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: request.method,
      params: request.params ?? [],
    }),
    signal: resolveSignal(signal, timeoutMs),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    const envelope = isErrorEnvelope(body) ? body : undefined;
    throw new MetagraphedError(
      envelope?.error?.message ??
        `RPC ${request.method} failed with status ${response.status}`,
      response.status,
      envelope?.error?.code,
      envelope,
    );
  }
  const rpcError = (
    body as { error?: { code?: unknown; message?: unknown } }
  )?.error;
  if (rpcError) {
    throw new MetagraphedError(
      typeof rpcError.message === "string" ? rpcError.message : "JSON-RPC error",
      response.status,
      rpcError.code === undefined || rpcError.code === null
        ? undefined
        : String(rpcError.code),
    );
  }
  return (body as { result?: Result })?.result as Result;
}

// Manual linear-time scan rather than a regex: a regex equivalent to this
// (matching /\{([^}]+)\}/g against a path built from arbitrary segments)
// was flagged by CodeQL as ReDoS-prone (quadratic backtracking on inputs with
// many unmatched "{"). This has the same semantics -- an unmatched or empty
// "{}" is left as literal text, matching the regex's [^}]+ (one-or-more)
// requirement -- with guaranteed O(n) time.
function interpolatePath(
  path: string,
  params: Record<string, string | number> | undefined,
) {
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
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    result += encodeURIComponent(String(value));
    i = close + 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// DX layer (issue #750): an opt-in client wrapper over the typed surface above
// adding retries/backoff, ETag conditional caching, convenience methods, and a
// fetchAll auto-pagination helper. The typed core (metagraphedFetch etc.) is
// unchanged and stays the zero-config entrypoint. Everything here is additive
// and tree-shakeable: import createMetagraphedClient only if you want it.
// ---------------------------------------------------------------------------

/** Opt-in retry/backoff configuration. Retries are OFF unless enabled. */
export interface RetryOptions {
  /** Max retry attempts after the first try (default 2). 0 disables retries. */
  retries?: number;
  /** Base backoff in ms before exponential growth + jitter (default 200). */
  minDelayMs?: number;
  /** Backoff ceiling in ms (default 10000). */
  maxDelayMs?: number;
  /** Retryable HTTP statuses (default 429, 500, 502, 503, 504). */
  statuses?: number[];
}

/** Pluggable ETag store. Defaults to a bounded in-memory LRU when caching is on. */
export interface EtagCache {
  get(key: string): { etag: string; body: unknown } | undefined;
  set(key: string, entry: { etag: string; body: unknown }): void;
}

const DEFAULT_CACHE_MAX_ENTRIES = 256;

/**
 * A bounded in-memory LRU ETag store — the default when caching is enabled. Evicts
 * the least-recently-used entry once it exceeds maxEntries, so a long-lived client
 * over high-cardinality URLs (per-subnet detail, paginated cursor pages) can't grow
 * the cache without bound. Pass a custom { get, set } store for different eviction
 * or persistence, or call createLruEtagCache(n) directly to size it.
 */
export function createLruEtagCache(
  maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES,
): EtagCache {
  const entries = new Map<string, { etag: string; body: unknown }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry !== undefined) {
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
        if (oldest === undefined) {
          break;
        }
        entries.delete(oldest);
      }
    },
  };
}

export interface MetagraphedClientOptions {
  /** API origin (default https://api.metagraph.sh). */
  baseUrl?: string;
  /** Per-request timeout in ms (default 30000; 0 disables). */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Fetch implementation (default globalThis.fetch); useful for tests. */
  fetch?: typeof fetch;
  /** Opt-in retries: true (defaults), a retry count, or full RetryOptions. */
  retry?: RetryOptions | number | boolean;
  /** Opt-in ETag conditional caching: true (a bounded in-memory LRU) or a custom { get, set } store. */
  cache?: boolean | EtagCache;
}

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

function resolveRetry(
  retry: RetryOptions | number | boolean | undefined,
): Required<RetryOptions> | null {
  if (!retry) {
    return null;
  }
  const opts: RetryOptions =
    typeof retry === "number"
      ? { retries: retry }
      : retry === true
        ? {}
        : retry;
  const retries = opts.retries ?? 2;
  if (retries <= 0) {
    return null;
  }
  return {
    retries,
    minDelayMs: opts.minDelayMs ?? 200,
    maxDelayMs: opts.maxDelayMs ?? 10000,
    statuses: opts.statuses ?? RETRYABLE_STATUSES,
  };
}

/**
 * Backoff before the next attempt: honor a Retry-After header (delta-seconds or
 * an HTTP date) when present, otherwise exponential backoff with equal jitter
 * (50-100% of the computed backoff), both capped at maxDelayMs.
 */
function retryDelayMs(
  response: Response | undefined,
  attempt: number,
  retry: Required<RetryOptions>,
): number {
  const header = response ? response.headers.get("retry-after") : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(0, seconds) * 1000, retry.maxDelayMs);
    }
    const dateMs = Date.parse(header);
    if (Number.isFinite(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), retry.maxDelayMs);
    }
  }
  const expo = Math.min(retry.minDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(expo * (0.5 + Math.random() / 2));
}

function sleep(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
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

function buildRequestUrl(
  path: string,
  baseUrl: string,
  pathParams: Record<string, string | number> | undefined,
  query: Record<string, unknown> | undefined,
): URL {
  const url = new URL(interpolatePath(path, pathParams), baseUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function mergeRequestHeaders(
  clientHeaders: Record<string, string> | undefined,
  requestHeaders: HeadersInit | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { accept: "application/json" };
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

function hashCacheKeyPart(value: string): string {
  let high = 0xdeadbeef;
  let low = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 2654435761);
    low = Math.imul(low ^ code, 1597334677);
  }
  high =
    Math.imul(high ^ (high >>> 16), 2246822507) ^
    Math.imul(low ^ (low >>> 13), 3266489909);
  low =
    Math.imul(low ^ (low >>> 16), 2246822507) ^
    Math.imul(high ^ (high >>> 13), 3266489909);
  return (
    (low >>> 0).toString(16).padStart(8, "0") +
    (high >>> 0).toString(16).padStart(8, "0")
  );
}

function buildEtagCacheKey(
  url: URL,
  requestHeaders: Record<string, string>,
): string {
  const headerKey = hashCacheKeyPart(
    Object.entries(requestHeaders)
      .filter(([key]) => key !== "if-none-match")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => key + ":" + value)
      .join("\n"),
  );
  return url.toString() + "\n" + headerKey;
}

/**
 * A typed client with opt-in retries + ETag caching, ergonomic convenience
 * methods for the v1 collections, and fetchAll auto-pagination. Build one with
 * createMetagraphedClient.
 */
export interface MetagraphedClient {
  request<Path extends ApiPath>(
    path: Path,
    options?: MetagraphedFetchOptions<Path>,
  ): Promise<JsonResponse<Path>>;
  paginate<Path extends ApiPath>(
    path: Path,
    options?: MetagraphedFetchOptions<Path>,
  ): AsyncGenerator<JsonResponse<Path>, void, unknown>;
  fetchAll<Item = unknown, Path extends ApiPath = ApiPath>(
    path: Path,
    options?: MetagraphedFetchOptions<Path>,
  ): Promise<Item[]>;
  rpc<Result = unknown>(
    network: string,
    request: JsonRpcRequest,
    options?: MetagraphedRpcOptions,
  ): Promise<Result>;
  subnets(
    query?: QueryParams<"/api/v1/subnets">,
    options?: MetagraphedFetchOptions<"/api/v1/subnets">,
  ): Promise<JsonResponse<"/api/v1/subnets">>;
  getSubnet(
    netuid: number,
    options?: MetagraphedFetchOptions<"/api/v1/subnets/{netuid}">,
  ): Promise<JsonResponse<"/api/v1/subnets/{netuid}">>;
  providers(
    query?: QueryParams<"/api/v1/providers">,
    options?: MetagraphedFetchOptions<"/api/v1/providers">,
  ): Promise<JsonResponse<"/api/v1/providers">>;
  getProvider(
    slug: string,
    options?: MetagraphedFetchOptions<"/api/v1/providers/{slug}">,
  ): Promise<JsonResponse<"/api/v1/providers/{slug}">>;
  surfaces(
    query?: QueryParams<"/api/v1/surfaces">,
    options?: MetagraphedFetchOptions<"/api/v1/surfaces">,
  ): Promise<JsonResponse<"/api/v1/surfaces">>;
  endpoints(
    query?: QueryParams<"/api/v1/endpoints">,
    options?: MetagraphedFetchOptions<"/api/v1/endpoints">,
  ): Promise<JsonResponse<"/api/v1/endpoints">>;
  candidates(
    query?: QueryParams<"/api/v1/candidates">,
    options?: MetagraphedFetchOptions<"/api/v1/candidates">,
  ): Promise<JsonResponse<"/api/v1/candidates">>;
  profiles(
    query?: QueryParams<"/api/v1/profiles">,
    options?: MetagraphedFetchOptions<"/api/v1/profiles">,
  ): Promise<JsonResponse<"/api/v1/profiles">>;
  health(
    options?: MetagraphedFetchOptions<"/api/v1/health">,
  ): Promise<JsonResponse<"/api/v1/health">>;
}

/**
 * Build a configured client. All enhancements are opt-in: with no options it
 * behaves like metagraphedFetch (no retries, no caching). Enable retries with
 * { retry: true } and ETag caching with { cache: true }.
 */
export function createMetagraphedClient(
  clientOptions: MetagraphedClientOptions = {},
): MetagraphedClient {
  const baseUrl = clientOptions.baseUrl ?? "https://api.metagraph.sh";
  const fetchImpl = clientOptions.fetch ?? globalThis.fetch;
  const retry = resolveRetry(clientOptions.retry);
  const store: EtagCache | null = clientOptions.cache
    ? clientOptions.cache === true
      ? createLruEtagCache()
      : clientOptions.cache
    : null;

  async function request<Path extends ApiPath>(
    path: Path,
    options: MetagraphedFetchOptions<Path> = {},
  ): Promise<JsonResponse<Path>> {
    const {
      baseUrl: requestBaseUrl,
      pathParams,
      query,
      timeoutMs = clientOptions.timeoutMs ?? 30000,
      signal,
      headers,
      ...init
    } = options;
    const url = buildRequestUrl(
      String(path),
      requestBaseUrl ?? baseUrl,
      pathParams as Record<string, string | number> | undefined,
      query as Record<string, unknown> | undefined,
    );
    let attempt = 0;
    let retriedUncachedNotModified = false;
    for (;;) {
      const requestHeaders = mergeRequestHeaders(clientOptions.headers, headers);
      const key = buildEtagCacheKey(url, requestHeaders);
      const cached = !retriedUncachedNotModified && store ? store.get(key) : undefined;
      if (cached) {
        requestHeaders["if-none-match"] = cached.etag;
      } else if (retriedUncachedNotModified) {
        delete requestHeaders["if-none-match"];
        delete requestHeaders["if-modified-since"];
      }
      let response: Response;
      try {
        response = await fetchImpl(url, {
          ...init,
          method: "GET",
          headers: requestHeaders,
          signal: resolveSignal(signal, timeoutMs),
        });
      } catch (error) {
        // A caller-initiated abort is intentional — never retry it. Transient
        // transport failures (DNS, connection reset, or the per-attempt timeout
        // firing) are retried within the retry budget, then rethrown.
        if (signal && signal.aborted) {
          throw error;
        }
        if (retry && attempt < retry.retries) {
          await sleep(retryDelayMs(undefined, attempt, retry), signal);
          attempt += 1;
          continue;
        }
        throw error;
      }
      if (response.status === 304) {
        if (cached) {
          return cached.body as JsonResponse<Path>;
        }
        // Not Modified, but the store no longer has the entry (a shared/evicting
        // store can drop it between send and receipt). Re-issue once without
        // conditional headers to get a full body, but never loop on repeated 304s.
        if (retriedUncachedNotModified) {
          throw new MetagraphedError(
            "GET " + url.pathname + " returned 304 without a cached response",
            response.status,
          );
        }
        retriedUncachedNotModified = true;
        continue;
      }
      if (
        retry &&
        retry.statuses.includes(response.status) &&
        attempt < retry.retries
      ) {
        await sleep(retryDelayMs(response, attempt, retry), signal);
        attempt += 1;
        continue;
      }
      const body = await readJsonBody(response);
      if (!response.ok) {
        const envelope = isErrorEnvelope(body) ? body : undefined;
        throw new MetagraphedError(
          envelope?.error?.message ??
            "GET " + url.pathname + " failed with status " + response.status,
          response.status,
          envelope?.error?.code,
          envelope,
        );
      }
      if (store) {
        const etag = response.headers.get("etag");
        if (etag) {
          store.set(key, { etag, body });
        }
      }
      return body as JsonResponse<Path>;
    }
  }

  async function* paginate<Path extends ApiPath>(
    path: Path,
    options: MetagraphedFetchOptions<Path> = {},
  ): AsyncGenerator<JsonResponse<Path>, void, unknown> {
    const baseQuery: Record<string, unknown> = {
      ...(options.query as Record<string, unknown> | undefined),
    };
    let cursor: unknown = baseQuery.cursor;
    for (;;) {
      if (cursor !== undefined && cursor !== null) {
        baseQuery.cursor = cursor;
      }
      const page = await request(path, {
        ...options,
        query: baseQuery as unknown as QueryParams<Path>,
      });
      yield page;
      const next = (
        page as { meta?: { pagination?: { next_cursor?: unknown } } }
      )?.meta?.pagination?.next_cursor;
      if (next === undefined || next === null) {
        return;
      }
      cursor = next;
    }
  }

  async function fetchAll<Item = unknown, Path extends ApiPath = ApiPath>(
    path: Path,
    options: MetagraphedFetchOptions<Path> = {},
  ): Promise<Item[]> {
    const items: Item[] = [];
    for await (const page of paginate(path, options)) {
      // List endpoints nest their rows under data[meta.pagination.collection]
      // (e.g. data.subnets), not as a bare array. Resolve the collection key,
      // falling back to a flat data array or the single array-valued field.
      const data = (page as { data?: unknown }).data;
      if (Array.isArray(data)) {
        items.push(...(data as Item[]));
        continue;
      }
      if (typeof data !== "object" || data === null) {
        continue;
      }
      const record = data as Record<string, unknown>;
      const collection = (
        page as { meta?: { pagination?: { collection?: unknown } } }
      ).meta?.pagination?.collection;
      if (typeof collection === "string" && Array.isArray(record[collection])) {
        items.push(...(record[collection] as Item[]));
        continue;
      }
      const arrays = Object.values(record).filter((value) =>
        Array.isArray(value),
      );
      if (arrays.length === 1) {
        items.push(...(arrays[0] as Item[]));
      }
    }
    return items;
  }

  function rpc<Result = unknown>(
    network: string,
    rpcRequest: JsonRpcRequest,
    options: MetagraphedRpcOptions = {},
  ): Promise<Result> {
    return metagraphedRpc<Result>(network, rpcRequest, { baseUrl, ...options });
  }

  return {
    request,
    paginate,
    fetchAll,
    rpc,
    subnets: (query, options) =>
      request("/api/v1/subnets", { ...options, query }),
    getSubnet: (netuid, options) =>
      request("/api/v1/subnets/{netuid}", {
        ...options,
        pathParams: { netuid } as PathParams<"/api/v1/subnets/{netuid}">,
      }),
    providers: (query, options) =>
      request("/api/v1/providers", { ...options, query }),
    getProvider: (slug, options) =>
      request("/api/v1/providers/{slug}", {
        ...options,
        pathParams: { slug } as PathParams<"/api/v1/providers/{slug}">,
      }),
    surfaces: (query, options) =>
      request("/api/v1/surfaces", { ...options, query }),
    endpoints: (query, options) =>
      request("/api/v1/endpoints", { ...options, query }),
    candidates: (query, options) =>
      request("/api/v1/candidates", { ...options, query }),
    profiles: (query, options) =>
      request("/api/v1/profiles", { ...options, query }),
    health: (options) => request("/api/v1/health", { ...options }),
  };
}

/**
 * Every string-enum query parameter the published contract declares, keyed by
 * route path then parameter name. "as const", so a consumer derives literal
 * unions instead of restating them (#10994).
 */
export const QUERY_PARAMETER_ENUMS = {
  "/api/v1/accounts": {
    "format": ["json","csv"],
    "sort": ["total_stake","total_emission","subnet_count","uid_count","validator_count","stake_dominance","last_active"],
  },
  "/api/v1/accounts/top-holders": {
    "format": ["json","csv"],
    "sort": ["total_tao","free_tao","delegated_tao","net_flow_7d","net_flow_30d","net_flow_90d"],
  },
  "/api/v1/accounts/{ss58}/axon-removals": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/counterparties": {
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/deregistrations": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/events": {
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/extrinsics": {
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/history": {
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/identity-history": {
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/prometheus": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/registrations": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/serving": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/stake-flow": {
    "direction": ["all","in","out"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/stake-moves": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/accounts/{ss58}/subnets/{netuid}/history": {
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/accounts/{ss58}/transfers": {
    "direction": ["all","sent","received"],
    "format": ["json","csv"],
  },
  "/api/v1/accounts/{ss58}/weight-setters": {
    "window": ["7d","30d"],
  },
  "/api/v1/agent-catalog": {
    "order": ["asc","desc"],
    "sort": ["netuid","callable_count","completeness_score","example_count"],
  },
  "/api/v1/blocks": {
    "format": ["json","csv"],
  },
  "/api/v1/blocks/{ref}/events": {
    "format": ["json","csv"],
  },
  "/api/v1/blocks/{ref}/extrinsics": {
    "format": ["json","csv"],
  },
  "/api/v1/candidates": {
    "confidence": ["low","medium","high"],
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["confidence","id","kind","name","netuid","provider","state"],
    "state": ["schema-invalid","schema-valid","maintainer-review","verified","stale","rejected"],
  },
  "/api/v1/chain-events": {
    "format": ["json","csv"],
  },
  "/api/v1/chain/activity": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/alpha-volume": {
    "format": ["json","csv"],
  },
  "/api/v1/chain/axon-removals": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/calls": {
    "format": ["json","csv"],
    "group_by": ["module","module_function"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/concentration/history": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/chain/concentration/subnets": {
    "lens": ["emission","stake","entity_emission","entity_stake","validator_stake"],
    "order": ["asc","desc"],
    "sort": ["nakamoto_coefficient","gini","holders","top_1pct_share","total","netuid"],
  },
  "/api/v1/chain/deregistrations": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/emission-pipeline": {
    "order": ["asc","desc"],
    "sort": ["final_share","emission_share","weighted_share","gated_share","gate_delta","distance_to_bar","tao_in_emission","excess_tao","tao_total","liquidity_fraction","miner_burned","netuid"],
  },
  "/api/v1/chain/fees": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/governance/emission-changes": {
    "kind": ["param","subnet","flow"],
  },
  "/api/v1/chain/holders": {
    "sort": ["top1_share","top5_share","top10_share","top20_share","holder_count","total_alpha"],
  },
  "/api/v1/chain/prometheus": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/registrations": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/revenue-coverage": {
    "window": ["1d","7d","30d"],
  },
  "/api/v1/chain/serving": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/signers": {
    "format": ["json","csv"],
    "sort": ["tx_count","total_fee_tao"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/stake-flow": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/stake-moves": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/stake-transfers": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/stream": {
    "topics": ["blocks","extrinsics","chain_events","account_events"],
  },
  "/api/v1/chain/subnet-lifecycle": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/chain/transfer-pairs": {
    "format": ["json","csv"],
    "sort": ["volume","count"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/transfers": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/turnover": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/chain/weights": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/chain/weights/setters": {
    "format": ["json","csv"],
    "window": ["7d","30d"],
  },
  "/api/v1/contracts": {
    "order": ["asc","desc"],
    "sort": ["id","path","contract_version"],
  },
  "/api/v1/coverage-depth": {
    "agent_status": ["callable","base-layer","candidate","needs-evidence","blocked"],
    "blocker_level": ["none","hard-blocked","needs-review","missing-data"],
    "format": ["json","csv"],
    "order": ["asc","desc"],
    "sort": ["agent_status","blocker_level","name","netuid","priority_score","score","tier"],
    "tier": ["agent-ready","machine-usable","candidate-review","needs-evidence","hard-blocked","missing-interface"],
  },
  "/api/v1/curation": {
    "coverage_level": ["native-only","manifested","probed"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "order": ["asc","desc"],
    "sort": ["coverage_level","curation_level","name","netuid"],
  },
  "/api/v1/domains/{tag}/summary": {
    "tag": ["agents","compute","data","finance","inference","media","prediction","privacy","robotics","science","search","security","storage","training"],
  },
  "/api/v1/economics": {
    "format": ["json","csv"],
    "order": ["asc","desc"],
    "registration_allowed": ["true","false"],
    "sort": ["alpha_fdv_tao","alpha_market_cap_tao","alpha_price_change_1d","alpha_price_change_1h","alpha_price_change_1m","alpha_price_change_7d","alpha_price_tao","block","emission_share","max_stake_alpha","max_uids","max_validators","miner_count","miner_readiness","name","netuid","open_slots","registration_cost_tao","subnet_volume_tao","total_stake_alpha","validator_count"],
  },
  "/api/v1/economics/trends": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/endpoint-incidents": {
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "severity": ["critical","warning","info"],
    "sort": ["detected_at","endpoint_id","kind","last_checked","netuid","provider","severity","state","status"],
    "state": ["active","resolved"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/endpoint-pools": {
    "kind": ["subtensor-rpc","subtensor-wss","archive"],
    "order": ["asc","desc"],
    "sort": ["eligible_count","endpoint_count","id","kind"],
  },
  "/api/v1/endpoints": {
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "known_status": ["true","false"],
    "layer": ["bittensor-base","data-provider","docs-provider","subnet-app"],
    "order": ["asc","desc"],
    "pool_eligible": ["true","false"],
    "publication_state": ["candidate","verified","monitored","pool-eligible","disabled","rejected"],
    "sort": ["kind","last_checked","latency_ms","layer","netuid","pool_eligible","provider","publication_state","score","status"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/evidence": {
    "order": ["asc","desc"],
    "sort": ["claim","source_url","subject","verified_at"],
  },
  "/api/v1/extrinsics": {
    "format": ["json","csv"],
    "success": ["true","false"],
  },
  "/api/v1/fixtures": {
    "order": ["asc","desc"],
    "sort": ["captured_at","netuid","surface_id"],
  },
  "/api/v1/gaps": {
    "coverage_level": ["native-only","manifested","probed"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "order": ["asc","desc"],
    "sort": ["coverage_level","curation_level","gap_count","name","netuid"],
  },
  "/api/v1/governance/config-changes": {
    "format": ["json","csv"],
    "success": ["true","false"],
  },
  "/api/v1/health": {
    "order": ["asc","desc"],
    "sort": ["avg_latency_ms","degraded_count","failed_count","last_checked","last_ok","name","netuid","ok_count","status","surface_count","unknown_count"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/health/failure-reasons": {
    "window": ["7d","30d","90d","180d"],
  },
  "/api/v1/health/history/{date}": {
    "classification": ["auth-required","content-mismatch","dead","live","rate-limited","redirected","timeout","transient","unsupported","unsafe","wrong-chain"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["classification","kind","last_checked","last_ok","latency_ms","netuid","provider","status","status_code","surface_id","verified_at"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/health/trends": {
    "window": ["7d","30d"],
  },
  "/api/v1/incidents": {
    "order": ["asc","desc"],
    "sort": ["downtime_ms","incident_count","netuid","surface_id"],
    "window": ["7d","30d"],
  },
  "/api/v1/network/tao-usd": {
    "window": ["1h","24h","7d","30d"],
  },
  "/api/v1/profiles": {
    "confidence": ["low","medium","high"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "format": ["json","csv"],
    "order": ["asc","desc"],
    "profile_level": ["directory-only","identity-partial","identity-complete","operational","adapter-backed"],
    "sort": ["candidate_count","completeness_score","curation_level","interface_count","missing_critical_count","name","netuid","operational_interface_count","profile_level","review_state"],
    "subnet_type": ["root","application"],
  },
  "/api/v1/providers": {
    "authority": ["community","official","provider-claimed","registry-observed"],
    "format": ["json","csv"],
    "kind": ["data-provider","docs-provider","infrastructure-provider","registry","subnet-team"],
    "order": ["asc","desc"],
    "sort": ["authority","id","kind","name"],
  },
  "/api/v1/providers/{slug}/endpoints": {
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "known_status": ["true","false"],
    "layer": ["bittensor-base","data-provider","docs-provider","subnet-app"],
    "order": ["asc","desc"],
    "pool_eligible": ["true","false"],
    "publication_state": ["candidate","verified","monitored","pool-eligible","disabled","rejected"],
    "sort": ["kind","last_checked","latency_ms","layer","netuid","pool_eligible","provider","publication_state","score","status"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/registry/leaderboards": {
    "board": ["healthiest","fastest-rpc","most-complete","most-enriched","fastest-growing","most-reliable","open-slots","cheapest-registration","highest-emission","validator-headroom","biggest-alpha-gain-1d","biggest-alpha-gain-7d"],
  },
  "/api/v1/review/adapter-candidates": {
    "candidate_api_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "format": ["json","csv"],
    "operational_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "recommended_adapter_kind": ["custom-adapter","data-artifact-adapter","generic-openapi-or-custom","stream-adapter"],
    "sort": ["candidate_api_count","candidate_api_kinds","curation_level","name","netuid","operational_kinds","operational_surface_count","priority_score","recommended_adapter_kind"],
  },
  "/api/v1/review/enrichment-evidence": {
    "direct_submission_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "evidence_action": ["submit-new-evidence","verify-existing-evidence","replace-stale-evidence","review-existing-evidence","maintainer-review-existing-evidence","monitor"],
    "lane": ["direct-submission","maintainer-review","adapter-candidate","monitoring-followup","baseline-monitoring"],
    "missing_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["evidence_action","lane","name","netuid","priority_score"],
  },
  "/api/v1/review/enrichment-queue": {
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "direct_submission_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "evidence_action": ["submit-new-evidence","verify-existing-evidence","replace-stale-evidence","review-existing-evidence","maintainer-review-existing-evidence","monitor"],
    "format": ["json","csv"],
    "identity_level": ["none","directory","partial","complete"],
    "lane": ["direct-submission","maintainer-review","adapter-candidate","monitoring-followup","baseline-monitoring"],
    "manual_review_required": ["true","false"],
    "missing_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "profile_level": ["directory-only","identity-partial","identity-complete","operational","adapter-backed"],
    "sort": ["adapter_score","candidate_count","completeness_score","curation_level","endpoint_count","evidence_action","identity_level","identity_surface_count","lane","name","netuid","operational_interface_count","priority_score","profile_level","review_state","stale_candidate_count","surface_count","verified_candidate_count"],
  },
  "/api/v1/review/enrichment-targets": {
    "auto_review_candidate": ["true","false"],
    "evidence_action": ["submit-new-evidence","verify-existing-evidence","replace-stale-evidence","review-existing-evidence","maintainer-review-existing-evidence","monitor"],
    "identity_level": ["none","directory","partial","complete"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "lane": ["direct-submission","maintainer-review","adapter-candidate","monitoring-followup","baseline-monitoring"],
    "manual_review_required": ["true","false"],
    "missing_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "profile_level": ["directory-only","identity-partial","identity-complete","operational","adapter-backed"],
    "sort": ["auto_review_candidate","evidence_action","identity_level","kind","lane","manual_review_required","name","netuid","priority_score","profile_level","submission_route","target_action","target_type"],
    "submission_route": ["direct-candidate-pr","adapter-request","maintainer-review","status-report"],
    "target_action": ["submit-new-candidate","replace-stale-candidate","verify-existing-candidate","review-existing-candidate","adapter-review","maintainer-review","monitoring-followup"],
    "target_type": ["surface-candidate","adapter-review","maintainer-review","monitoring-followup"],
  },
  "/api/v1/review/gaps": {
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "format": ["json","csv"],
    "missing_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["candidate_count","curation_level","missing_kinds","name","netuid","priority_score","surface_count","verified_candidate_count"],
  },
  "/api/v1/review/profile-completeness": {
    "confidence": ["low","medium","high"],
    "format": ["json","csv"],
    "identity_level": ["none","directory","partial","complete"],
    "identity_promotion_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "native_name_quality": ["chain","placeholder","empty"],
    "order": ["asc","desc"],
    "profile_level": ["directory-only","identity-partial","identity-complete","operational","adapter-backed"],
    "sort": ["candidate_count","completeness_score","identity_level","identity_promotion_kind_count","identity_surface_count","live_identity_candidate_kind_count","missing_critical_count","name","native_identity_signal_count","native_name_quality","netuid","priority_score","profile_level","stale_identity_candidate_kind_count"],
  },
  "/api/v1/rpc/endpoints": {
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "known_status": ["true","false"],
    "layer": ["bittensor-base","data-provider","docs-provider","subnet-app"],
    "order": ["asc","desc"],
    "pool_eligible": ["true","false"],
    "publication_state": ["candidate","verified","monitored","pool-eligible","disabled","rejected"],
    "sort": ["kind","last_checked","latency_ms","layer","netuid","pool_eligible","provider","publication_state","score","status"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/rpc/pools": {
    "kind": ["subtensor-rpc","subtensor-wss","archive"],
    "order": ["asc","desc"],
    "sort": ["eligible_count","endpoint_count","id","kind"],
  },
  "/api/v1/rpc/usage": {
    "window": ["7d","30d"],
  },
  "/api/v1/runtime": {
    "format": ["json","csv"],
  },
  "/api/v1/search": {
    "order": ["asc","desc"],
    "sort": ["netuid","slug","title","type"],
    "type": ["subnet","surface","provider"],
  },
  "/api/v1/search-index": {
    "order": ["asc","desc"],
    "sort": ["netuid","slug","title","type"],
    "type": ["subnet","surface","provider"],
  },
  "/api/v1/search/semantic": {
    "type": ["subnet","surface","provider"],
  },
  "/api/v1/source-snapshots": {
    "order": ["asc","desc"],
    "sort": ["id","kind","path","record_count"],
  },
  "/api/v1/subnets": {
    "coverage_level": ["native-only","manifested","probed"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "domain": ["agents","compute","data","finance","inference","media","prediction","privacy","robotics","science","search","security","storage","training"],
    "format": ["json","csv"],
    "order": ["asc","desc"],
    "sort": ["block","candidate_count","coverage_level","curation_level","integration_readiness","mechanism_count","name","netuid","participant_count","probed_surface_count","status","subnet_type","surface_count","tempo"],
    "status": ["active","inactive"],
    "subnet_type": ["root","application"],
  },
  "/api/v1/subnets/movers": {
    "format": ["json","csv"],
    "sort": ["stake","emission","validators","neurons"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/axon-removals": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/burn/history": {
    "window": ["24h","7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/candidates": {
    "confidence": ["low","medium","high"],
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["confidence","id","kind","name","netuid","provider","state"],
    "state": ["schema-invalid","schema-valid","maintainer-review","verified","stale","rejected"],
  },
  "/api/v1/subnets/{netuid}/concentration/history": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/deregistration-ranking/history": {
    "window": ["7d","30d","90d","180d"],
  },
  "/api/v1/subnets/{netuid}/deregistrations": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/emission-pipeline/history": {
    "window": ["7d","30d","90d","180d"],
  },
  "/api/v1/subnets/{netuid}/emission-split/history": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/endpoints": {
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "known_status": ["true","false"],
    "layer": ["bittensor-base","data-provider","docs-provider","subnet-app"],
    "order": ["asc","desc"],
    "pool_eligible": ["true","false"],
    "publication_state": ["candidate","verified","monitored","pool-eligible","disabled","rejected"],
    "sort": ["kind","last_checked","latency_ms","layer","netuid","pool_eligible","provider","publication_state","score","status"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/subnets/{netuid}/event-summary": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/events": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/evidence": {
    "order": ["asc","desc"],
    "sort": ["claim","source_url","subject","verified_at"],
  },
  "/api/v1/subnets/{netuid}/gaps": {
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "format": ["json","csv"],
    "missing_kinds": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["candidate_count","curation_level","missing_kinds","name","netuid","priority_score","surface_count","verified_candidate_count"],
  },
  "/api/v1/subnets/{netuid}/health": {
    "classification": ["auth-required","content-mismatch","dead","live","rate-limited","redirected","timeout","transient","unsupported","unsafe","wrong-chain"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "sort": ["classification","kind","last_checked","last_ok","latency_ms","netuid","provider","status","status_code","surface_id","verified_at"],
    "status": ["ok","degraded","failed","unknown"],
  },
  "/api/v1/subnets/{netuid}/health/incidents": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/health/percentiles": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/history": {
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/subnets/{netuid}/hyperparameters/history": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/identity-history": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/lifecycle": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/metagraph": {
    "format": ["json","csv"],
    "validator_permit": ["true"],
  },
  "/api/v1/subnets/{netuid}/miner-fairness": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/neurons/{uid}/history": {
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/subnets/{netuid}/ohlc": {
    "interval": ["1h","1d"],
  },
  "/api/v1/subnets/{netuid}/owner-capture": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/performance/history": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/prometheus": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/registrations": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/revenue": {
    "window": ["1d","7d","30d"],
  },
  "/api/v1/subnets/{netuid}/serving": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/stake-flow": {
    "direction": ["all","in","out"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/stake-moves": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/stake-quote": {
    "direction": ["stake","unstake"],
  },
  "/api/v1/subnets/{netuid}/stake-transfers": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/surfaces": {
    "auth_required": ["true","false"],
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "public_safe": ["true","false"],
    "rate_limited": ["true","false"],
    "sort": ["id","kind","name","netuid","provider"],
  },
  "/api/v1/subnets/{netuid}/trajectory": {
    "format": ["json","csv"],
    "order": ["asc","desc"],
    "sort": ["date","completeness_score","surface_count","endpoint_count"],
  },
  "/api/v1/subnets/{netuid}/turnover": {
    "changes": ["true","false"],
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/subnets/{netuid}/uptime": {
    "format": ["json","csv"],
    "window": ["90d","1y"],
  },
  "/api/v1/subnets/{netuid}/validator-economics/history": {
    "window": ["7d","30d","90d"],
  },
  "/api/v1/subnets/{netuid}/validators": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/weights": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/weights/setters": {
    "window": ["7d","30d"],
  },
  "/api/v1/subnets/{netuid}/yield": {
    "format": ["json","csv"],
  },
  "/api/v1/subnets/{netuid}/yield/history": {
    "format": ["json","csv"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/sudo": {
    "format": ["json","csv"],
    "success": ["true","false"],
  },
  "/api/v1/surfaces": {
    "auth_required": ["true","false"],
    "format": ["json","csv"],
    "kind": ["archive","dashboard","data-artifact","docs","example","openapi","repo-registry","sdk","source-repo","sse","subnet-api","subtensor-rpc","subtensor-wss","website"],
    "order": ["asc","desc"],
    "public_safe": ["true","false"],
    "rate_limited": ["true","false"],
    "sort": ["id","kind","name","netuid","provider"],
  },
  "/api/v1/validators": {
    "format": ["json","csv"],
    "sort": ["avg_validator_trust","max_validator_trust","stake_dominance","subnet_count","total_emission","total_stake","uid_count"],
  },
  "/api/v1/validators/economics": {
    "sort": ["earning_floor_cost_tao","permit_floor_cost_tao","permit_to_earning_multiple","tao_inflow_per_day","validator_headroom"],
  },
  "/api/v1/validators/{hotkey}/history": {
    "window": ["7d","30d","90d","1y","all"],
  },
  "/api/v1/validators/{hotkey}/nominators": {
    "basis": ["flow","positions"],
    "format": ["json","csv"],
    "sort": ["net_staked","gross_staked","last_activity"],
    "window": ["7d","30d","90d"],
  },
  "/api/v1/{network}/accounts/{ss58}/balance": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/accounts/{ss58}/children": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/accounts/{ss58}/parents": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/accounts/{ss58}/root-claim": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks/summary": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks/{ref}": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks/{ref}/chain-events": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks/{ref}/events": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/blocks/{ref}/extrinsics": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/chain-events": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/chain-events/stats": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/chain/activity": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/alpha-volume": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/chain/burn": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/chain/calls": {
    "format": ["json","csv"],
    "group_by": ["module","module_function"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/deregistrations": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/fees": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/prometheus": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/registrations": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/serving": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/signers": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "sort": ["tx_count","total_fee_tao"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/stake-flow": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/stake-moves": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/stake-transfers": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/transfer-pairs": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "sort": ["volume","count"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/transfers": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/weights": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/chain/weights/setters": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "window": ["7d","30d"],
  },
  "/api/v1/{network}/coverage": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/crowdloans": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/crowdloans/{crowdloan_id}": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/economics": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "order": ["asc","desc"],
    "registration_allowed": ["true","false"],
    "sort": ["alpha_fdv_tao","alpha_market_cap_tao","alpha_price_change_1d","alpha_price_change_1h","alpha_price_change_1m","alpha_price_change_7d","alpha_price_tao","block","emission_share","max_stake_alpha","max_uids","max_validators","miner_count","miner_readiness","name","netuid","open_slots","registration_cost_tao","subnet_volume_tao","total_stake_alpha","validator_count"],
  },
  "/api/v1/{network}/evm/address/{h160}": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/export/chain-events": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/extrinsics": {
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "success": ["true","false"],
  },
  "/api/v1/{network}/extrinsics/{hash}": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/network/parameters": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/network/randomness": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/networks": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/search/resolve": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/subnets": {
    "coverage_level": ["native-only","manifested","probed"],
    "curation_level": ["native","candidate-discovered","community-seeded","machine-verified","maintainer-reviewed","adapter-backed"],
    "domain": ["agents","compute","data","finance","inference","media","prediction","privacy","robotics","science","search","security","storage","training"],
    "format": ["json","csv"],
    "network": ["finney","mainnet","test","testnet"],
    "order": ["asc","desc"],
    "sort": ["block","candidate_count","coverage_level","curation_level","integration_readiness","mechanism_count","name","netuid","participant_count","probed_surface_count","status","subnet_type","surface_count","tempo"],
    "status": ["active","inactive"],
    "subnet_type": ["root","application"],
  },
  "/api/v1/{network}/subnets/{netuid}": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/subnets/{netuid}/burn": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/subnets/{netuid}/lease": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/subnets/{netuid}/recycled": {
    "network": ["finney","mainnet","test","testnet"],
  },
  "/api/v1/{network}/sudo/key": {
    "network": ["finney","mainnet","test","testnet"],
  },
} as const;
