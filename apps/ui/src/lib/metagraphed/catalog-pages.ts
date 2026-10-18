import type { QueryClient, QueryKey, FetchInfiniteQueryOptions } from "@tanstack/react-query";
import { apiFetch, ApiError, buildUrl, type ApiResult, type QueryParams } from "./client";

export interface CatalogPageParam {
  cursor: number;
  snapshot: string;
  total?: number;
}

export const FIRST_CATALOG_PAGE: CatalogPageParam = { cursor: 0, snapshot: "start" };

export class CatalogRestartRequired extends Error {
  constructor() {
    super("These results changed or could not be verified. Refresh results to start again.");
    this.name = "CatalogRestartRequired";
  }
}

const validSnapshot = (value: unknown): value is string =>
  typeof value === "string" && /^v1\.[0-9a-f]{64}$/.test(value);

/** No fallback to unguarded offsets: an old server cannot certify this walk. */
export async function fetchCatalogPage<T>(
  path: string,
  key: string,
  baseParams: QueryParams,
  page: CatalogPageParam,
  signal?: AbortSignal,
): Promise<ApiResult<T[]>> {
  let response: ApiResult<Record<string, unknown>>;
  try {
    response = await apiFetch<Record<string, unknown>>(path, {
      params: { ...baseParams, cursor: page.cursor, page_snapshot: page.snapshot },
      signal,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.parameter === "page_snapshot" &&
      (error.catalogReason === undefined || error.catalogReason === "catalog_changed")
    ) {
      throw new CatalogRestartRequired();
    }
    throw error;
  }
  const rows = response.data?.[key];
  const p = response.meta.pagination;
  if (
    !Array.isArray(rows) ||
    !p ||
    !validSnapshot(p.snapshot) ||
    (page.snapshot !== "start" && p.snapshot !== page.snapshot) ||
    (page.total !== undefined && p.total !== page.total) ||
    p.cursor !== page.cursor ||
    p.returned !== rows.length ||
    !Number.isSafeInteger(p.total) ||
    (p.total as number) < page.cursor + rows.length
  )
    throw new CatalogRestartRequired();
  const end = page.cursor + rows.length;
  if (p.next_cursor === null) {
    if (end !== p.total) throw new CatalogRestartRequired();
  } else if (rows.length === 0 || p.next_cursor !== end || end >= (p.total as number))
    throw new CatalogRestartRequired();
  return { ...response, data: rows as T[] };
}

export function nextCatalogPage(last: ApiResult<unknown>): CatalogPageParam | undefined {
  const p = last.meta.pagination;
  if (p?.next_cursor == null) return undefined;
  if (
    !validSnapshot(p.snapshot) ||
    typeof p.next_cursor !== "number" ||
    !Number.isSafeInteger(p.total)
  ) {
    throw new CatalogRestartRequired();
  }
  return { cursor: p.next_cursor, snapshot: p.snapshot, total: p.total };
}

/** Complete one checked walk before exporting anything; never retry a changed walk. */
export async function collectCatalogRows<T>(
  path: string,
  key: string,
  params: QueryParams,
  signal?: AbortSignal,
) {
  const rows: T[] = [];
  const originScope = buildUrl(path);
  let page: CatalogPageParam | undefined = FIRST_CATALOG_PAGE;
  let bytes = 0;
  for (let count = 0; page && count < 50; count += 1) {
    signal?.throwIfAborted();
    if (buildUrl(path) !== originScope)
      throw new Error("The network changed. Start the export again.");
    const result = await fetchCatalogPage<T>(path, key, { ...params, limit: 1000 }, page, signal);
    signal?.throwIfAborted();
    if (buildUrl(path) !== originScope)
      throw new Error("The network changed. Start the export again.");
    bytes += new TextEncoder().encode(JSON.stringify(result.data)).byteLength;
    if (bytes > 16 * 1024 * 1024 || rows.length + result.data.length > 50_000) {
      throw new Error("This export is too large. Narrow the filters and try again.");
    }
    rows.push(...result.data);
    page = nextCatalogPage(result);
  }
  if (page) throw new Error("This export has too many pages. Narrow the filters and try again.");
  return rows;
}

/** Replace atomically with one fresh first page; failure retains accepted data. */
export async function restartCatalogResults<T, TKey extends QueryKey>(
  client: QueryClient,
  options: FetchInfiniteQueryOptions<T, Error, T, TKey, CatalogPageParam>,
) {
  await client.cancelQueries({ queryKey: options.queryKey, exact: true });
  try {
    await client.fetchInfiniteQuery({ ...options, pages: 1, staleTime: 0, retry: false });
    return true;
  } catch {
    // React Query owns the visible error alongside retained data. UI handlers
    // can fire-and-forget without an unhandled rejection or an implicit retry.
    return false;
  }
}

/** Retained rows are accepted historical results, not a fresh observation. */
export function catalogRetentionNotice(
  state: { isFetching: boolean; isFetchingNextPage: boolean; isError: boolean },
  count: number,
  acceptedScope?: string,
): string | undefined {
  if (!count) return undefined;
  const prefix = acceptedScope ? acceptedScope + " · " : "";
  if (state.isFetching && !state.isFetchingNextPage)
    return prefix + "Refreshing results · previously accepted rows retained · current freshness unverified";
  if (state.isError) return "Previously accepted rows retained · current freshness unverified";
  return undefined;
}
