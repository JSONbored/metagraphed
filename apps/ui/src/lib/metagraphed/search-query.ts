import { queryOptions } from "@tanstack/react-query";
import { apiFetch, type ApiResult } from "./client";
import { getNetwork } from "./config";

export interface SearchIndexHit {
  id: string;
  kind?: string;
  type?: string;
  title?: string;
  subtitle?: string;
  url?: string;
  netuid?: number;
  slug?: string;
}

function searchDocuments(raw: unknown): SearchIndexHit[] {
  if (Array.isArray(raw)) return raw as SearchIndexHit[];
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.documents)) return record.documents as SearchIndexHit[];
  const fallback = Object.values(record).find(Array.isArray);
  return (fallback ?? []) as SearchIndexHit[];
}

/**
 * The global omnibox needs only this one small query. Keeping it outside the
 * full query registry prevents every route from parsing all page-specific
 * normalizers before the user has asked to search.
 */
export const searchQuery = (q: string, limit = 20) =>
  queryOptions({
    queryKey: ["metagraphed", { network: getNetwork().id }, "search-index", q, limit],
    // Typeahead uses the slim /search-index (the same documents, ranking, and q/limit
    // filtering as /search, but without the per-document token blobs) for a lighter,
    // faster browser round-trip on every keystroke (#3490).
    queryFn: async ({ signal }) => {
      const res = await apiFetch<unknown>("/api/v1/search-index", {
        params: { q, limit },
        signal,
      });
      return {
        ...res,
        data: searchDocuments(res.data),
      } as ApiResult<SearchIndexHit[]>;
    },
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });
