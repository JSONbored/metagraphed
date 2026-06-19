/**
 * This file was auto-generated from public/metagraph/openapi.json.
 * Do not make direct changes to the file.
 */

import type { components, paths } from "./metagraphed-api";

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

function interpolatePath(
  path: string,
  params: Record<string, string | number> | undefined,
) {
  if (!params) {
    return path;
  }
  return path.replace(/\{([^}]+)\}/g, (_match, key) => {
    const value = params[key];
    if (value === undefined || value === null) {
      throw new Error(`Missing path parameter: ${key}`);
    }
    return encodeURIComponent(String(value));
  });
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

function buildEtagCacheKey(
  url: URL,
  requestHeaders: Record<string, string>,
): string {
  const headerKey = Object.entries(requestHeaders)
    .filter(([key]) => key !== "if-none-match")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => key + ":" + value)
    .join("\n");
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
      const data = (page as { data?: unknown }).data;
      if (Array.isArray(data)) {
        items.push(...(data as Item[]));
      } else if (data !== undefined && data !== null) {
        items.push(data as Item);
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
