import type { QueryClient } from "@tanstack/react-query";

export const BLOCK_EXTRINSIC_PAGE_SIZE = 25;

export type BlockRouteSelection =
  | { status: "ready"; height: string; pins?: { block_hash: string; publication_id: string } }
  | { status: "invalid" };

/**
 * Select the published block a /blocks/$ref visit asks for.
 *
 * The modern explorer serves canonical decimal heights only — hash-only
 * lookup is not a published read. A continuation pin is all-or-nothing: a
 * block_hash without its publication_id (or the reverse) selects nothing.
 */
export function blockRouteSelection(
  ref: string,
  search: { block_hash?: string; publication_id?: string },
): BlockRouteSelection {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(ref)) return { status: "invalid" };
  const { block_hash, publication_id } = search;
  if (block_hash === undefined && publication_id === undefined)
    return { status: "ready", height: ref };
  if (
    block_hash !== undefined &&
    /^0x[0-9a-f]{64}$/.test(block_hash) &&
    publication_id !== undefined &&
    /^[0-9a-f]{64}$/.test(publication_id)
  )
    return { status: "ready", height: ref, pins: { block_hash, publication_id } };
  return { status: "invalid" };
}

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
