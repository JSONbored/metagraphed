import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainYieldQuery, normalizeChainYield } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/yield",
  });
}

async function runQuery() {
  const opts = chainYieldQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainYield", () => {
  it("passes a well-formed yield snapshot through", () => {
    expect(
      normalizeChainYield({
        schema_version: 1,
        subnet_count: 2,
        neuron_count: 100,
        validator_count: 10,
        miner_count: 90,
        captured_at: "2026-07-01T00:00:00Z",
        total_stake_tao: 1000,
        total_emission_tao: 5,
        network_yield: 0.005,
        validator_yield: 0.004,
        miner_yield: 0.02,
        distribution: {
          count: 80,
          mean: 0.01,
          median: 0.002,
          min: 0,
          max: 5,
          p10: 0,
          p25: 0.001,
          p75: 0.01,
          p90: 0.05,
        },
      }),
    ).toEqual({
      schema_version: 1,
      subnet_count: 2,
      neuron_count: 100,
      validator_count: 10,
      miner_count: 90,
      captured_at: "2026-07-01T00:00:00Z",
      total_stake_tao: 1000,
      total_emission_tao: 5,
      network_yield: 0.005,
      validator_yield: 0.004,
      miner_yield: 0.02,
      distribution: {
        count: 80,
        mean: 0.01,
        median: 0.002,
        min: 0,
        max: 5,
        p10: 0,
        p25: 0.001,
        p75: 0.01,
        p90: 0.05,
      },
    });
  });

  it("degrades a cold / junk snapshot to a schema-stable zeroed shape", () => {
    for (const raw of [{}, null, "x", { neuron_count: "nope" }]) {
      const card = normalizeChainYield(raw);
      expect(card.neuron_count).toBe(0);
      expect(card.network_yield).toBeNull();
      expect(card.validator_yield).toBeNull();
      expect(card.miner_yield).toBeNull();
      expect(card.distribution).toBeNull();
    }
  });

  it("coerces junk yields to null and drops a malformed distribution", () => {
    const card = normalizeChainYield({
      neuron_count: 5,
      network_yield: { pct: 1 },
      distribution: { mean: 0.1 },
    });
    expect(card.neuron_count).toBe(5);
    expect(card.network_yield).toBeNull();
    // distribution requires a numeric count; missing count drops it to null.
    expect(card.distribution).toBeNull();
  });
});

describe("chainYieldQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("calls /api/v1/chain/yield and normalizes the snapshot", async () => {
    resolveWith({ neuron_count: 3, network_yield: 0.01 });
    const res = await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/yield",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data.neuron_count).toBe(3);
    expect(res.data.network_yield).toBe(0.01);
  });
});
