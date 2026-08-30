import { getApiBase, getNetworkPrefix } from "./config";
import { recordApiLatency } from "./api-latency.ts";
import type { ApiEnvelope, ApiMeta } from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;
  url: string;
  /**
   * The response envelope's `meta.network`, when present. Set on every
   * network-partition 404 (`workers/api.ts`'s `handleNetworkScopedRequest`
   * paths — mainnet-only blocklist hits, the `local` network's no-data 404,
   * and its catch-all unmatched-route 404) so callers can distinguish
   * "unavailable on this network by design" from an ordinary 404, without
   * relying on a specific error `code`.
   */
  network?: string;
  constructor(
    message: string,
    opts: { status: number; code?: string; url: string; network?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.url = opts.url;
    this.network = opts.network;
  }
}

export interface ApiResult<T> {
  data: T;
  meta: ApiMeta;
  url: string;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

// Inserts the selected chain network's path prefix after /api/v1 or /metagraph
// (mainnet has prefix "" → no-op). So /api/v1/subnets becomes
// /api/v1/testnet/subnets when Testnet is selected — same origin, different
// data partition, matching the backend's /{network}/ routing.
export function applyNetworkPrefix(p: string): string {
  const prefix = getNetworkPrefix();
  if (!prefix) return p;
  for (const root of ["/api/v1", "/metagraph"]) {
    if (p === root) return `${root}/${prefix}`;
    if (p.startsWith(`${root}/`)) {
      return `${root}/${prefix}/${p.slice(root.length + 1)}`;
    }
  }
  return p;
}

export function buildUrl(path: string, params?: QueryParams): string {
  const base = getApiBase().replace(/\/$/, "");
  const p = applyNetworkPrefix(path.startsWith("/") ? path : `/${path}`);
  const url = new URL(base + p);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item === undefined || item === null || item === "") continue;
          url.searchParams.append(k, String(item));
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

function redactUrlForError(url: string): string {
  const redacted = new URL(url);
  redacted.search = "";
  return redacted.toString();
}

/**
 * Fetch a JSON envelope from the Metagraphed API and unwrap it.
 * Tolerates plain (non-enveloped) JSON by treating the whole body as `data`.
 */
export async function apiFetch<T>(
  path: string,
  opts: { params?: QueryParams; signal?: AbortSignal; init?: RequestInit } = {},
): Promise<ApiResult<T>> {
  const url = buildUrl(path, opts.params);
  // Every call is a real round trip to the API's own origin, so timing it here
  // is what lets the footer health dot stop issuing a probe of its own -- see
  // lib/metagraphed/api-latency.ts. Recorded on BOTH paths: a failure is the
  // sample that renders "down", and dropping it would leave the last good
  // number on screen while nothing works.
  const startedAt = performance.now?.() ?? Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: opts.signal,
      ...opts.init,
    });
  } catch (err) {
    // An ABORT is not a measurement. React Query cancels in-flight requests on
    // unmount and on every keystroke behind a debounce, and reporting those as
    // "down" would paint the dot red on ordinary navigation.
    if (!opts.signal?.aborted) recordApiLatency(null);
    throw new ApiError((err as Error).message || "Network error", {
      status: 0,
      url: redactUrlForError(url),
    });
  }
  recordApiLatency(Math.round((performance.now?.() ?? Date.now()) - startedAt));

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON response
    }
  }

  if (!res.ok) {
    const env = body as Partial<ApiEnvelope<unknown>> | null;
    throw new ApiError(env?.error?.message || res.statusText || "Request failed", {
      status: res.status,
      code: env?.error?.code,
      url: redactUrlForError(url),
      network: env?.meta?.network,
    });
  }

  // Envelope or raw payload
  if (body && typeof body === "object" && "ok" in (body as object)) {
    const env = body as ApiEnvelope<T>;
    if (env.ok === false) {
      throw new ApiError(env.error?.message || "API returned ok:false", {
        status: res.status,
        code: env.error?.code,
        url: redactUrlForError(url),
        network: env.meta?.network,
      });
    }
    // Some collection routes deliberately return a schema-stable empty 200
    // when their backing tier cannot answer. The response header is the contract
    // that separates that fallback from a measured empty result. Promote it to
    // the same typed error the UI already uses for unavailable data tiers so a
    // zero-row fallback can never be presented as real network activity.
    if (res.headers.get("x-metagraph-degraded") === "tier_unavailable") {
      throw new ApiError("The data tier could not verify this response", {
        status: res.status,
        code: "data_tier_unavailable",
        url: redactUrlForError(url),
      });
    }
    return { data: env.data, meta: env.meta ?? {}, url };
  }

  if (res.headers.get("x-metagraph-degraded") === "tier_unavailable") {
    throw new ApiError("The data tier could not verify this response", {
      status: res.status,
      code: "data_tier_unavailable",
      url: redactUrlForError(url),
    });
  }
  return { data: body as T, meta: {}, url };
}
