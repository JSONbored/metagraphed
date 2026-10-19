import { applyQueryFilters, type Row } from "../../../../workers/list-query.ts";

/**
 * Test-only boundary: rows are the fixture owner's complete, already matched
 * result. Aliases may deliberately be absent from projected fixture rows, so
 * the production engine owns paging/snapshot validation but never repeats the
 * owner's search/filter matching. The original URL still binds query scope.
 */
export function matchedCatalogFixture(
  url: URL,
  collection: "endpoints" | "surfaces",
  rows: readonly Row[],
  payload: Record<string, unknown> = {},
  { pageSize, omitTotal = false }: { pageSize?: number; omitTotal?: boolean } = {},
) {
  const paging = new URL(url);
  paging.search = "";
  for (const [key, value] of url.searchParams) {
    if (["cursor", "limit", "page_snapshot"].includes(key)) paging.searchParams.append(key, value);
  }
  if (pageSize !== undefined) paging.searchParams.set("limit", String(pageSize));
  const result = applyQueryFilters(
    { ...(payload.data as Record<string, unknown> | undefined), [collection]: rows },
    paging,
    collection === "surfaces" ? "curated-surfaces" : "endpoints",
    [],
    { snapshotUrl: url },
  );
  if (result.error) {
    return {
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { code: "invalid_query", message: result.error.message },
        meta: { parameter: result.error.parameter },
      }),
    };
  }
  const pagination: Record<string, unknown> = { ...result.meta.pagination };
  // Deliberate malformed response, used only by the client's fail-closed test.
  if (omitTotal) delete pagination.total;
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ...payload,
      ok: true,
      data: result.data,
      meta: {
        ...(payload.meta as Record<string, unknown> | undefined),
        ...result.meta,
        pagination,
      },
    }),
  };
}
