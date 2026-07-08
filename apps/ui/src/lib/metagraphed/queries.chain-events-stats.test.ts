import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainEventsStatsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain-events/stats",
  });
}

async function runQuery(blocks?: number) {
  const opts = blocks == null ? chainEventsStatsQuery() : chainEventsStatsQuery(blocks);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("chainEventsStatsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the blocks param and normalizes busiest-first rows", async () => {
    resolveWith({
      window_blocks: 1000,
      groups: 2,
      activity: [
        { pallet: "Balances", method: "Transfer", count: 200593 },
        { pallet: "System", method: "ExtrinsicSuccess", count: 24307 },
      ],
    });
    const res = await runQuery(1000);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain-events/stats",
      expect.objectContaining({ params: { blocks: 1000 } }),
    );
    expect(res.data.window_blocks).toBe(1000);
    expect(res.data.groups).toBe(2);
    expect(res.data.activity).toHaveLength(2);
    expect(res.data.activity[0]).toEqual({
      pallet: "Balances",
      method: "Transfer",
      count: 200593,
    });
  });

  it("defaults to a 1000-block window", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain-events/stats",
      expect.objectContaining({ params: { blocks: 1000 } }),
    );
  });

  it("degrades a cold / junk store to a schema-stable empty card", async () => {
    for (const raw of [{}, null, "x", { groups: "nope", activity: "nope" }]) {
      resolveWith(raw);
      const res = await runQuery(500);
      expect(res.data.groups).toBe(0);
      expect(res.data.activity).toEqual([]);
      // window_blocks falls through to the requested block count on a cold store
      expect(res.data.window_blocks).toBe(500);
    }
  });

  it("drops malformed rows (missing pallet or count) and preserves a null method", async () => {
    resolveWith({
      groups: 3,
      activity: [
        { method: "Transfer", count: 5 }, // no pallet -> dropped
        { pallet: "Balances", count: "nope" }, // junk count -> dropped
        { pallet: "SubtensorModule", count: 5169 }, // no method -> kept, method null
      ],
    });
    const res = await runQuery();
    expect(res.data.activity).toHaveLength(1);
    expect(res.data.activity[0]).toEqual({
      pallet: "SubtensorModule",
      method: null,
      count: 5169,
    });
  });

  it("caps the rendered rows at the top 100 groups", async () => {
    resolveWith({
      groups: 150,
      activity: Array.from({ length: 150 }, (_, i) => ({
        pallet: `Pallet${i}`,
        method: "M",
        count: 150 - i,
      })),
    });
    const res = await runQuery();
    expect(res.data.activity).toHaveLength(100);
    expect(res.data.activity[0]?.count).toBe(150);
  });
});
