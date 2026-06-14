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
