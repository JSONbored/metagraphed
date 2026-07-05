import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainEventsStatsQuery, normalizeChainEventsStats } from "./queries";

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
  const opts = chainEventsStatsQuery(blocks);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainEventsStats", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeChainEventsStats({
        window_blocks: 500,
        groups: 2,
        activity: [
          { pallet: "System", method: "ExtrinsicSuccess", count: 120 },
          { pallet: "Balances", method: "Transfer", count: 40 },
        ],
      }),
    ).toEqual({
      window_blocks: 500,
      groups: 2,
      activity: [
        { pallet: "System", method: "ExtrinsicSuccess", count: 120 },
        { pallet: "Balances", method: "Transfer", count: 40 },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable empty card", () => {
    for (const raw of [{}, null, "x", { groups: "nope" }]) {
      const card = normalizeChainEventsStats(raw);
      expect(card.groups).toBe(0);
      expect(card.activity).toEqual([]);
      expect(card.window_blocks).toBe(1000);
    }
  });

  it("drops rows with no pallet or method identity", () => {
    const card = normalizeChainEventsStats({
      activity: [{ count: 1 }, { pallet: "System", method: "NewAccount", count: 2 }],
    });
    expect(card.activity).toHaveLength(1);
    expect(card.activity[0]?.pallet).toBe("System");
  });
});

describe("chainEventsStatsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the blocks param and normalizes the card", async () => {
    resolveWith({ window_blocks: 500, groups: 1, activity: [{ pallet: "System", count: 3 }] });
    const res = await runQuery(500);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain-events/stats",
      expect.objectContaining({ params: { blocks: 500 } }),
    );
    expect(res.data.window_blocks).toBe(500);
    expect(res.data.activity).toHaveLength(1);
  });

  it("defaults to the 1000-block window", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain-events/stats",
      expect.objectContaining({ params: { blocks: 1000 } }),
    );
  });
});
