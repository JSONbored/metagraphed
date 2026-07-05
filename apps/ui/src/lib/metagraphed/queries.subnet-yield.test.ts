import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { subnetYieldQuery, subnetYieldHistoryQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/1/yield",
  });
}

async function runYieldQuery(netuid = 1) {
  const opts = subnetYieldQuery(netuid);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

async function runYieldHistoryQuery(netuid = 1, window: "7d" | "30d" | "90d" = "30d") {
  const opts = subnetYieldHistoryQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe("subnetYieldQuery", () => {
  it("normalizes the distribution summary and per-UID rows", async () => {
    resolveWith({
      netuid: 1,
      captured_at: "2026-07-05T00:00:00.000Z",
      block_number: 8555404,
      neuron_count: 3,
      validator_count: 1,
      miner_count: 2,
      total_stake_tao: 100,
      total_emission_tao: 2,
      subnet_yield: 0.00003,
      mean_yield: 0.004,
      median_yield: 0.000016,
      p25_yield: 0,
      p75_yield: 0.0000164,
      p90_yield: 0.0164,
      neurons: [
        {
          uid: 176,
          hotkey: "5CGSG3UgtPPoJ5QkMzM4BrqFQ4BwHjxRuAZRnzQs4Ek8DMgo",
          role: "miner",
          stake_tao: 19.53,
          emission_tao: 1.15,
          yield: 0.0589,
          vs_median: "above",
        },
        {
          uid: 4,
          hotkey: null,
          role: "validator",
          stake_tao: 50,
          emission_tao: 0.5,
          yield: null,
          vs_median: null,
        },
      ],
    });

    const res = await runYieldQuery(1);
    expect(res.data.netuid).toBe(1);
    expect(res.data.subnet_yield).toBe(0.00003);
    expect(res.data.median_yield).toBe(0.000016);
    expect(res.data.validator_count).toBe(1);
    expect(res.data.miner_count).toBe(2);
    expect(res.data.neurons).toHaveLength(2);
    expect(res.data.neurons[0]).toMatchObject({
      uid: 176,
      role: "miner",
      stake_tao: 19.53,
      yield: 0.0589,
      vs_median: "above",
    });
    // null-safe: missing hotkey → null, null yield preserved, unknown vs → null.
    expect(res.data.neurons[1]).toMatchObject({
      uid: 4,
      hotkey: null,
      role: "validator",
      yield: null,
      vs_median: null,
    });
  });

  it("drops malformed neuron rows and coerces an unknown role to miner", async () => {
    resolveWith({
      netuid: 1,
      neurons: [
        { uid: 7, role: "weird", stake_tao: 1, emission_tao: 0.1, yield: 0.1, vs_median: "below" },
        { hotkey: "no-uid" },
        null,
        42,
      ],
    });

    const res = await runYieldQuery(1);
    expect(res.data.neurons).toHaveLength(1);
    expect(res.data.neurons[0]).toMatchObject({ uid: 7, role: "miner", vs_median: "below" });
  });

  it("returns a schema-stable empty shape for a cold subnet", async () => {
    resolveWith({});
    const res = await runYieldQuery(9);
    expect(res.data.netuid).toBe(9);
    expect(res.data.neurons).toEqual([]);
    expect(res.data.subnet_yield).toBeNull();
    expect(res.data.median_yield).toBeNull();
  });
});

describe("subnetYieldHistoryQuery", () => {
  it("normalizes points and drops entries without a snapshot_date", async () => {
    resolveWith({
      netuid: 1,
      window: "30d",
      point_count: 2,
      points: [
        {
          snapshot_date: "2026-07-04",
          neuron_count: 256,
          validator_count: 9,
          yield_count: 23,
          subnet_yield: 0.0000323,
          mean_yield: 0.0077,
          median_yield: 0.0000159,
          p25_yield: 0,
          p75_yield: 0.0000164,
          p90_yield: 0.0164,
        },
        { neuron_count: 100 },
      ],
    });

    const res = await runYieldHistoryQuery(1, "30d");
    expect(res.data.netuid).toBe(1);
    expect(res.data.window).toBe("30d");
    expect(res.data.points).toHaveLength(1);
    expect(res.data.points[0]).toMatchObject({
      snapshot_date: "2026-07-04",
      subnet_yield: 0.0000323,
      median_yield: 0.0000159,
      yield_count: 23,
    });
  });

  it("returns an empty series for a cold subnet", async () => {
    resolveWith({ netuid: 5 });
    const res = await runYieldHistoryQuery(5, "7d");
    expect(res.data.points).toEqual([]);
    expect(res.data.point_count).toBe(0);
  });
});
