import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult, QueryParams } from "./client";
import { apiFetch } from "./client";
import { chainEventsInfiniteQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain-events",
  });
}

async function runPage(params: QueryParams = {}, pageParam = "") {
  const opts = chainEventsInfiniteQuery(params, pageParam);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    pageParam,
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("chainEventsInfiniteQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches the all-events feed with pallet/method filters and limit", async () => {
    resolveWith({ count: 0, events: [], next_cursor: null });
    await runPage({ pallet: "Balances", method: "Transfer", limit: 25 });
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain-events", {
      params: { pallet: "Balances", method: "Transfer", limit: 25 },
      signal: expect.any(AbortSignal),
    });
  });

  it("passes cursor pagination on subsequent pages", async () => {
    resolveWith({ count: 1, events: [], next_cursor: "100.5" });
    await runPage({ limit: 50 }, "200.3");
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain-events", {
      params: { limit: 50, cursor: "200.3" },
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes events and reads next_cursor from the data payload", async () => {
    resolveWith({
      count: 1,
      next_cursor: "100.0",
      events: [
        {
          block_number: "101",
          event_index: "2",
          pallet: "System",
          method: "ExtrinsicSuccess",
          observed_at: "1783313892001",
        },
      ],
    });
    const page = await runPage();
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({
      block_number: 101,
      event_index: 2,
      pallet: "System",
      method: "ExtrinsicSuccess",
      observed_at: new Date(1783313892001).toISOString(),
    });
    expect(page.meta?._next_cursor).toBe("100.0");
  });

  it("degrades a cold / junk store to a schema-stable empty page", async () => {
    for (const raw of [{}, null, "x", { events: "nope" }]) {
      resolveWith(raw);
      const page = await runPage();
      expect(page.data).toEqual([]);
    }
  });
});
