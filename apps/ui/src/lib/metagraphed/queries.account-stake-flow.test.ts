import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountStakeFlowQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 (ss58PathSegment rejects malformed input).
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${ALICE}/stake-flow`,
  });
}

async function runQuery(ss58: string, params?: { window?: "7d" | "30d" | "90d" }) {
  const opts = accountStakeFlowQuery(ss58, params);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountStakeFlowQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the stake-flow route with the window param and shapes the scorecard", async () => {
    resolveWith({
      ss58: ALICE,
      window: "7d",
      total_staked_tao: 100,
      total_unstaked_tao: 40,
      net_flow_tao: 60,
      gross_flow_tao: 140,
      direction: "accumulating",
      concentration: 0.5,
      dominant_netuid: 8,
      subnet_count: 1,
      subnets: [
        {
          netuid: 8,
          staked_tao: 100,
          unstaked_tao: 40,
          net_flow_tao: 60,
          gross_flow_tao: 140,
          flow_ratio: 0.42,
          direction: "accumulating",
          stake_events: 5,
          unstake_events: 2,
        },
      ],
    });
    const res = await runQuery(ALICE, { window: "7d" });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/stake-flow`,
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data).toMatchObject({
      ss58: ALICE,
      window: "7d",
      net_flow_tao: 60,
      gross_flow_tao: 140,
      direction: "accumulating",
      dominant_netuid: 8,
      subnet_count: 1,
    });
    expect(res.data.subnets[0]).toMatchObject({
      netuid: 8,
      direction: "accumulating",
      stake_events: 5,
    });
  });

  it("drops subnet rows with no netuid and coerces junk cells to null", async () => {
    resolveWith({
      ss58: ALICE,
      subnets: [
        { netuid: 3, net_flow_tao: "nope", gross_flow_tao: {} },
        { staked_tao: 1 }, // no netuid → dropped
      ],
    });
    const res = await runQuery(ALICE);
    expect(res.data.subnets).toEqual([
      {
        netuid: 3,
        staked_tao: null,
        unstaked_tao: null,
        net_flow_tao: null,
        gross_flow_tao: null,
        flow_ratio: null,
        direction: null,
        stake_events: null,
        unstake_events: null,
      },
    ]);
    // subnet_count falls back to the surviving-row count when absent.
    expect(res.data.subnet_count).toBe(1);
  });

  it("degrades a cold / idle account to an empty breakdown, defaulting the window", async () => {
    for (const raw of [{}, null, { subnets: "not-an-array" }]) {
      resolveWith(raw);
      const res = await runQuery(ALICE);
      expect(res.data.ss58).toBe(ALICE);
      expect(res.data.window).toBe("30d");
      expect(res.data.subnets).toEqual([]);
      expect(res.data.subnet_count).toBe(0);
      expect(res.data.net_flow_tao).toBeNull();
    }
  });
});
