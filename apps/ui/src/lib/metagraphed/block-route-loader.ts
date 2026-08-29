import type { QueryClient } from "@tanstack/react-query";
import { blockExtrinsicsInfiniteQuery, blockQuery } from "./queries";

export const BLOCK_EXTRINSIC_PAGE_SIZE = 100;

/**
 * Start the two reads required for the first useful block-detail render.
 *
 * The block header remains authoritative for route-level errors and absence.
 * The extrinsics ledger is secondary, so its prefetch is deliberately
 * non-fatal; the page owns its existing retry and recovery UI. Returning both
 * promises lets the route reject a missing block immediately while still
 * awaiting a valid block's prefetched ledger before completing navigation.
 */
export function startBlockRouteQueries(
  queryClient: Pick<QueryClient, "ensureQueryData" | "prefetchInfiniteQuery">,
  ref: string,
) {
  const block = queryClient.ensureQueryData(blockQuery(ref));
  const extrinsics = queryClient
    .prefetchInfiniteQuery(blockExtrinsicsInfiniteQuery(ref, BLOCK_EXTRINSIC_PAGE_SIZE))
    .catch(() => undefined);

  return { block, extrinsics };
}
