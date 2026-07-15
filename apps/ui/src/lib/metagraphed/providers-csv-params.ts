/**
 * Query params forwarded from the Providers page into the CSV export URL.
 *
 * Client-side ranking keys (`surfaces`/`endpoints`/…) are not on the API
 * sort enum — only backend-supported filters/sorts are passed through so the
 * download matches what `/api/v1/providers` can actually honor (#5665).
 */
export type ProvidersCsvSearch = {
  kind?: string;
  authority?: string;
  sort?: string;
};

const API_SORT_FIELDS = new Set(["authority", "id", "kind", "name"]);

/** Build `buildUrl` params for GET /api/v1/providers (without format=csv). */
export function providersCsvQueryParams(search: ProvidersCsvSearch): Record<string, string> {
  const params: Record<string, string> = {};
  if (search.kind) params.kind = search.kind;
  // `high` is a UI nav shortcut (official + provider-claimed), not an API enum.
  if (search.authority && search.authority !== "high") {
    params.authority = search.authority;
  }
  if (search.sort && API_SORT_FIELDS.has(search.sort)) {
    params.sort = search.sort;
  }
  return params;
}
