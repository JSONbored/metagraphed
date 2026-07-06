import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountStakeFlowQuery, normalizeAccountStakeFlow } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/accounts/5F/stake-flow",
  });
}

// Invoke a queryOptions' queryFn directly (the factory returns a fully-typed
// options object; each call site keeps its own precise data type).
function runQuery<
  O extends {
    queryKey: readonly unknown[];
    queryFn?: (context: never) => unknown;
  },
>(opts: O): ReturnType<NonNullable<O["queryFn"]>> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never) as ReturnType<NonNullable<O["queryFn"]>>;
}

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

describe("normalizeAccountStakeFlow", () => {
  it("passes a well-formed card through", () => {
    const raw = {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 120.5,
      total_unstaked_tao: 30.25,
      net_flow_tao: 90.25,
      gross_flow_tao: 150.75,
      flow_ratio: 0.5987,
      direction: "accumulating",
      stake_events: 9,
      unstake_events: 3,
      subnet_count: 2,
      concentration: 0.6123,
      dominant_netuid: 7,
      subnets: [
        {
          netuid: 7,
          staked_tao: 100,
          unstaked_tao: 20,
          net_flow_tao: 80,
          gross_flow_tao: 120,
          flow_ratio: 0.6667,
          direction: "accumulating",
          stake_events: 6,
          unstake_events: 2,
        },
        {
          netuid: 3,
          staked_tao: 20.5,
          unstaked_tao: 10.25,
          net_flow_tao: 10.25,
          gross_flow_tao: 30.75,
          flow_ratio: 0.3333,
          direction: "churning",
          stake_events: 3,
          unstake_events: 1,
        },
      ],
    };
    expect(normalizeAccountStakeFlow(SS58, raw)).toEqual(raw);
  });

  it("degrades cold / junk to a zeroed card (ratios null, direction idle, never NaN)", () => {
    for (const raw of [{}, null, { total_staked_tao: "nope", direction: "sideways" }]) {
      const card = normalizeAccountStakeFlow(SS58, raw);
      expect(card.address).toBe(SS58);
      expect(card.window).toBeNull();
      expect(card.total_staked_tao).toBe(0);
      expect(card.total_unstaked_tao).toBe(0);
      expect(card.net_flow_tao).toBe(0);
      expect(card.gross_flow_tao).toBe(0);
      expect(card.stake_events).toBe(0);
      expect(card.unstake_events).toBe(0);
      expect(card.flow_ratio).toBeNull();
      expect(card.concentration).toBeNull();
      expect(card.dominant_netuid).toBeNull();
      expect(card.direction).toBe("idle");
      expect(card.subnet_count).toBe(0);
      expect(card.subnets).toEqual([]);
    }
  });

  it("drops junk subnet rows and coerces their cells", () => {
    const card = normalizeAccountStakeFlow(SS58, {
      subnets: [
        null,
        { staked_tao: 5 },
        { netuid: 9, flow_ratio: "x", direction: "bogus", staked_tao: 4 },
      ],
    });
    expect(card.subnets).toHaveLength(1);
    expect(card.subnets[0]).toEqual({
      netuid: 9,
      staked_tao: 4,
      unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
    });
    expect(card.subnet_count).toBe(1);
  });
});

describe("accountStakeFlowQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits its route with the window param", async () => {
    resolveWith({ address: SS58, total_staked_tao: 42 });
    const res = await runQuery(accountStakeFlowQuery(SS58, "7d"));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/stake-flow`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.total_staked_tao).toBe(42);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(accountStakeFlowQuery(SS58));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${SS58}/stake-flow`,
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
