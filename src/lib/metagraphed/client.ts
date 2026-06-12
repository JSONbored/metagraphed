import { getApiBase } from "./config";
import type { ApiEnvelope, ApiMeta } from "./types";

export class ApiError extends Error {
  status: number;
  code?: string;
  url: string;
  constructor(message: string, opts: { status: number; code?: string; url: string }) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.url = opts.url;
  }
}

export interface ApiResult<T> {
  data: T;
  meta: ApiMeta;
  url: string;
}

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

function buildUrl(path: string, params?: QueryParams): string {
  const base = getApiBase().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
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
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: opts.signal,
      ...opts.init,
    });
  } catch (err) {
    throw new ApiError((err as Error).message || "Network error", {
      status: 0,
      url: redactUrlForError(url),
    });
  }

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
      });
    }
    return { data: env.data, meta: env.meta ?? {}, url };
  }
  return { data: body as T, meta: {}, url };
}
