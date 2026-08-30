import type { QueryClient } from "@tanstack/react-query";

export const BLOCK_EXTRINSIC_PAGE_SIZE = 25;

/**
 * Start the reads required for the first useful block-detail render.
 *
 * The block header remains authoritative for route-level errors and absence.
 * The extrinsics ledger is secondary, so its prefetch is deliberately
 * non-fatal; the page owns its existing retry and recovery UI. Returning both
 * Client navigations prime the ledger in parallel; direct server renders leave
 * it progressive so the response stays compact and exposes catch-up states.
 */
export async function startBlockRouteQueries(
  queryClient: Pick<QueryClient, "ensureQueryData" | "prefetchInfiniteQuery">,
  ref: string,
  prefetchExtrinsics = typeof window !== "undefined",
) {
  // Keep the full query registry out of the generated route tree's global
  // client entry. Both reads still start together once the route chunk opens.
  const { blockExtrinsicsInfiniteQuery, blockQuery } = await import("./queries");
  const block = queryClient.ensureQueryData(blockQuery(ref));
  const extrinsics = prefetchExtrinsics
    ? queryClient
        .prefetchInfiniteQuery(blockExtrinsicsInfiniteQuery(ref, BLOCK_EXTRINSIC_PAGE_SIZE))
        .catch(() => undefined)
    : Promise.resolve(undefined);

  return { block, extrinsics };
}
