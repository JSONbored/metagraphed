import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainStakeFlowQuery, normalizeChainStakeFlow } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/stake-flow",
  });
}

async function runQuery(window?: "7d" | "30d", limit?: number) {
  const opts = chainStakeFlowQuery(window, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainStakeFlow", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeChainStakeFlow({
        schema_version: 1,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: {
          total_staked_tao: 100,
          total_unstaked_tao: 80,
          net_flow_tao: 20,
          gross_flow_tao: 180,
          stake_events: 10,
          unstake_events: 8,
          gaining: 1,
          losing: 1,
          flat: 0,
        },
        net_flow_distribution: {
          count: 2,
          mean: 10,
          min: -5,
          p25: -2,
          median: 10,
          p75: 15,
          p90: 18,
          max: 20,
        },
        subnets: [
          {
            netuid: 1,
            total_staked_tao: 60,
            total_unstaked_tao: 40,
            net_flow_tao: 20,
            gross_flow_tao: 100,
            stake_events: 6,
            unstake_events: 4,
            direction: "inflow",
          },
        ],
      }),
    ).toMatchObject({
      subnet_count: 2,
      network: { net_flow_tao: 20, total_staked_tao: 100 },
      subnets: [{ netuid: 1, direction: "inflow" }],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { subnet_count: "nope" }]) {
      const card = normalizeChainStakeFlow(raw);
      expect(card.subnet_count).toBe(0);
      expect(card.network.total_staked_tao).toBe(0);
      expect(card.network.net_flow_tao).toBe(0);
      expect(card.subnets).toEqual([]);
      expect(card.net_flow_distribution).toBeNull();
    }
  });
});

describe("chainStakeFlowQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window and limit params and normalizes the card", async () => {
    resolveWith({
      window: "7d",
      subnet_count: 1,
      network: { total_staked_tao: 5, total_unstaked_tao: 3, net_flow_tao: 2 },
      subnets: [],
    });
    const res = await runQuery("7d", 12);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/stake-flow",
      expect.objectContaining({ params: { window: "7d", limit: 12 } }),
    );
    expect(res.data.network.net_flow_tao).toBe(2);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/stake-flow",
      expect.objectContaining({ params: { window: "30d", limit: 12 } }),
    );
  });
});
