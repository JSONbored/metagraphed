// Guarded catalog reads belong to catalog route chunks. Keep this module out
// of queries.ts: importing its pager there puts CSV traversal and validation
// into the shared query chunk even when a reader has not opened a catalog route.
import { infiniteQueryOptions } from "@tanstack/react-query";
import type { QueryParams } from "./client";
import type { Endpoint, Surface } from "./types";
import {
  metagraphedQueryKey as k,
  normalizeEndpoint,
  normalizeSurface,
  STALE_MED,
  type InfinitePage,
} from "./queries";
import {
  FIRST_CATALOG_PAGE,
  collectCatalogRows,
  fetchCatalogPage,
  nextCatalogPage,
} from "./catalog-pages";

/** Server-driven cursor-paginated surfaces. */
export const surfacesInfiniteQuery = (baseParams: QueryParams = {}) =>
  infiniteQueryOptions({
    queryKey: k("surfaces-infinite", baseParams),
    initialPageParam: FIRST_CATALOG_PAGE,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchCatalogPage<unknown>(
        "/api/v1/surfaces",
        "surfaces",
        baseParams,
        pageParam,
        signal,
      );
      // Normalize on the infinite-query path so provider_slug, curation_level
      // (from authority), provider, last_verified_at, and the provider filter
      // are populated — same mapping the non-paginated surfacesQuery applies.
      return { ...page, data: page.data.map(normalizeSurface) } as InfinitePage<Surface>;
    },
    getNextPageParam: nextCatalogPage,
    retry: false,
    staleTime: STALE_MED,
  });

export async function exportSurfaceRows(params: QueryParams, signal?: AbortSignal) {
  return (await collectCatalogRows<unknown>("/api/v1/surfaces", "surfaces", params, signal)).map(
    normalizeSurface,
  );
}

/** Cursor-paginated endpoints, for the directory's own server-side facets. */
export const endpointsInfiniteQuery = (baseParams: QueryParams = {}) =>
  infiniteQueryOptions({
    queryKey: k("endpoints-infinite", baseParams),
    initialPageParam: FIRST_CATALOG_PAGE,
    queryFn: async ({ pageParam, signal }) => {
      const page = await fetchCatalogPage<unknown>(
        "/api/v1/endpoints",
        "endpoints",
        baseParams,
        pageParam,
        signal,
      );
      return { ...page, data: page.data.map(normalizeEndpoint) } as InfinitePage<Endpoint>;
    },
    getNextPageParam: nextCatalogPage,
    retry: false,
    staleTime: STALE_MED,
  });

export async function exportEndpointRows(params: QueryParams, signal?: AbortSignal) {
  return (await collectCatalogRows<unknown>("/api/v1/endpoints", "endpoints", params, signal)).map(
    normalizeEndpoint,
  );
}
