import { describe, expect, it, vi } from "vitest";
import { BLOCK_EXTRINSIC_PAGE_SIZE, startBlockRouteQueries } from "./block-route-loader";

describe("startBlockRouteQueries", () => {
  it("starts the block header and first extrinsics page without a waterfall", async () => {
    let resolveBlock: ((value: unknown) => void) | undefined;
    const block = new Promise((resolve) => {
      resolveBlock = resolve;
    });
    const ensureQueryData = vi.fn(() => block);
    let prefetched: { queryKey?: readonly unknown[] } | undefined;
    const prefetchInfiniteQuery = vi.fn(async (options: typeof prefetched) => {
      prefetched = options;
    });

    const started = await startBlockRouteQueries(
      { ensureQueryData, prefetchInfiniteQuery } as never,
      "8713384",
      true,
    );

    expect(ensureQueryData).toHaveBeenCalledTimes(1);
    expect(prefetchInfiniteQuery).toHaveBeenCalledTimes(1);
    expect(prefetched?.queryKey).toEqual([
      "metagraphed",
      { network: "mainnet" },
      "block-extrinsics-infinite",
      "8713384",
      BLOCK_EXTRINSIC_PAGE_SIZE,
    ]);

    resolveBlock?.({ data: { block_number: 8713384 } });
    await expect(started.block).resolves.toEqual({ data: { block_number: 8713384 } });
    await expect(started.extrinsics).resolves.toBeUndefined();
  });

  it("keeps a secondary extrinsics failure out of the route-level error path", async () => {
    const started = await startBlockRouteQueries(
      {
        ensureQueryData: vi.fn(async () => ({ data: { block_number: 8713384 } })),
        prefetchInfiniteQuery: vi.fn(async () => {
          throw new Error("extrinsics unavailable");
        }),
      } as never,
      "8713384",
      true,
    );

    await expect(started.block).resolves.toEqual({ data: { block_number: 8713384 } });
    await expect(started.extrinsics).resolves.toBeUndefined();
  });

  it("leaves direct server renders progressive instead of dehydrating the ledger", async () => {
    const prefetchInfiniteQuery = vi.fn();
    const started = await startBlockRouteQueries(
      {
        ensureQueryData: vi.fn(async () => ({ data: { block_number: 8713384 } })),
        prefetchInfiniteQuery,
      } as never,
      "8713384",
      false,
    );

    expect(prefetchInfiniteQuery).not.toHaveBeenCalled();
    await expect(started.extrinsics).resolves.toBeUndefined();
  });
});
