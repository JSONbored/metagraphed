import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainStakeTransfersQuery, normalizeChainStakeTransfers } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/stake-transfers",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainStakeTransfersQuery(window, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainStakeTransfers", () => {
  it("passes a well-formed leaderboard through", () => {
    expect(
      normalizeChainStakeTransfers({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: { distinct_senders: 5, transfers: 70, transfers_per_sender: 14 },
        intensity_distribution: {
          count: 2,
          mean: 12.5,
          min: 10,
          p25: 10,
          median: 10,
          p75: 15,
          p90: 15,
          max: 15,
        },
        subnets: [
          { netuid: 1, distinct_senders: 4, transfers: 40, transfers_per_sender: 10 },
          { netuid: 2, distinct_senders: 2, transfers: 30, transfers_per_sender: 15 },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: { distinct_senders: 5, transfers: 70, transfers_per_sender: 14 },
      intensity_distribution: {
        count: 2,
        mean: 12.5,
        min: 10,
        p25: 10,
        median: 10,
        p75: 15,
        p90: 15,
        max: 15,
      },
      subnets: [
        { netuid: 1, distinct_senders: 4, transfers: 40, transfers_per_sender: 10 },
        { netuid: 2, distinct_senders: 2, transfers: 30, transfers_per_sender: 15 },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed leaderboard", () => {
    for (const raw of [{}, null, "x", { subnet_count: "nope" }]) {
      const card = normalizeChainStakeTransfers(raw);
      expect(card.subnet_count).toBe(0);
      expect(card.subnets).toEqual([]);
      expect(card.network).toEqual({
        distinct_senders: 0,
        transfers: 0,
        transfers_per_sender: null,
      });
      expect(card.intensity_distribution).toBeNull();
    }
  });

  it("drops malformed subnet rows and coerces a junk transfers_per_sender to null", () => {
    const card = normalizeChainStakeTransfers({
      network: { transfers_per_sender: { pct: 1 } },
      subnets: [{ distinct_senders: 4 }, { netuid: 2, transfers: 30 }],
    });
    expect(card.subnets).toHaveLength(1);
    expect(card.subnets[0]?.netuid).toBe(2);
    expect(card.subnets[0]?.transfers_per_sender).toBeNull();
    expect(card.network.transfers_per_sender).toBeNull();
  });
});

describe("chainStakeTransfersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window and limit params and normalizes the leaderboard", async () => {
    resolveWith({
      window: "30d",
      subnet_count: 1,
      network: { distinct_senders: 4, transfers: 40, transfers_per_sender: 10 },
      subnets: [{ netuid: 1, distinct_senders: 4, transfers: 40, transfers_per_sender: 10 }],
    });
    const res = await runQuery("30d", 5);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/stake-transfers",
      expect.objectContaining({ params: { window: "30d", limit: 5 } }),
    );
    expect(res.data.subnet_count).toBe(1);
    expect(res.data.subnets).toHaveLength(1);
  });

  it("defaults to the 7d window and limit 20", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/stake-transfers",
      expect.objectContaining({ params: { window: "7d", limit: 20 } }),
    );
  });
});
