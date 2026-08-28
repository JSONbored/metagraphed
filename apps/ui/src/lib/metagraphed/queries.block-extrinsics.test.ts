import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { blockExtrinsicsInfiniteQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/blocks/5000000/extrinsics",
  });
}

async function runPage(pageParam = 0, pageSize = 100) {
  const opts = blockExtrinsicsInfiniteQuery("5000000", pageSize);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    pageParam,
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
    direction: "forward",
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("blockExtrinsicsInfiniteQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("keeps the established first-page cache key free of offset=0", async () => {
    resolveWith({ block_number: 5000000, extrinsic_count: 1, extrinsics: [] });
    await runPage();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/blocks/5000000/extrinsics", {
      params: { limit: 100 },
      signal: expect.any(AbortSignal),
    });
  });

  it("requests the exact loaded offset on a subsequent page", async () => {
    resolveWith({ block_number: 5000000, extrinsic_count: 123, extrinsics: [] });
    await runPage(100);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/blocks/5000000/extrinsics", {
      params: { limit: 100, offset: 100 },
      signal: expect.any(AbortSignal),
    });
  });

  it("continues only while a full page leaves the block header's total unseen", () => {
    const opts = blockExtrinsicsInfiniteQuery("5000000", 2, 3);
    const page = (count: number, total: number) => ({
      data: {
        extrinsic_count: total,
        extrinsics: Array.from({ length: count }, (_, index) => ({
          block_number: 5000000,
          extrinsic_index: index,
          extrinsic_hash: null,
        })),
      },
      meta: {},
      url: "",
    });
    const first = page(2, 3);
    expect(opts.getNextPageParam?.(first, [first], 0, [0])).toBe(2);
    const second = page(1, 3);
    expect(opts.getNextPageParam?.(second, [first, second], 2, [0, 2])).toBeUndefined();
  });

  it("does not mistake the subresource's per-page count for a total", () => {
    const opts = blockExtrinsicsInfiniteQuery("5000000", 2);
    const first = {
      data: {
        // The live API reports 2 here for a full two-row page, even when the
        // block header says there are more calls after it.
        extrinsic_count: 2,
        extrinsics: [0, 1].map((extrinsic_index) => ({
          block_number: 5000000,
          extrinsic_index,
          extrinsic_hash: null,
        })),
      },
      meta: {},
      url: "",
    };
    expect(opts.getNextPageParam?.(first, [first], 0, [0])).toBe(2);
  });
});
