import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetMovers, subnetMoversQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/movers",
  });
}

async function runQuery(params?: { window?: string; sort?: string; limit?: number }) {
  const opts = params == null ? subnetMoversQuery() : subnetMoversQuery(params);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetMovers", () => {
  it("passes a well-formed board through", () => {
    const card = normalizeSubnetMovers({
      schema_version: 1,
      window: "30d",
      sort: "stake",
      subnet_count: 1,
      network: { gainers: 5, losers: 3, unchanged: 2 },
      movers: [
        {
          netuid: 64,
          stake_start_tao: 100,
          stake_end_tao: 250,
          stake_delta_tao: 150,
          stake_pct_change: 1.5,
          stake_share_pct: 2.1,
          emission_delta_tao: 9,
          validators_delta: 4,
          neurons_delta: 8,
        },
      ],
    });
    expect(card.network).toEqual({ gainers: 5, losers: 3, unchanged: 2 });
    expect(card.movers).toHaveLength(1);
    expect(card.movers[0]?.netuid).toBe(64);
    expect(card.movers[0]?.stake_delta_tao).toBe(150);
    expect(card.movers[0]?.stake_pct_change).toBe(1.5);
  });

  it("degrades a cold / junk store to a schema-stable card, never NaN", () => {
    for (const raw of [{}, null, "x", { movers: "nope", network: "nope" }]) {
      const card = normalizeSubnetMovers(raw);
      expect(card.movers).toEqual([]);
      expect(card.network).toBeNull();
      expect(card.window).toBe("30d");
      expect(card.sort).toBe("stake");
    }
  });

  it("drops malformed mover rows (no netuid) and coerces junk numbers to 0 / null", () => {
    const card = normalizeSubnetMovers({
      movers: [
        { stake_delta_tao: 5 }, // no netuid -> dropped
        { netuid: 12, stake_delta_tao: "junk", stake_pct_change: "junk" }, // kept, coerced
      ],
    });
    expect(card.movers).toHaveLength(1);
    expect(card.movers[0]?.netuid).toBe(12);
    expect(card.movers[0]?.stake_delta_tao).toBe(0);
    expect(card.movers[0]?.stake_pct_change).toBeNull();
  });
});

describe("subnetMoversQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window/sort/limit params and normalizes", async () => {
    resolveWith({ movers: [{ netuid: 1, stake_delta_tao: 3 }] });
    const res = await runQuery({ window: "7d", sort: "emission", limit: 5 });
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/movers",
      expect.objectContaining({ params: { window: "7d", sort: "emission", limit: 5 } }),
    );
    expect(res.data.movers).toHaveLength(1);
  });

  it("defaults to no explicit params (endpoint defaults 30d / stake)", async () => {
    resolveWith({});
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/movers",
      expect.objectContaining({ params: {} }),
    );
  });
});
