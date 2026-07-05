import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetStakeMoves, subnetStakeMovesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/stake-moves",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetStakeMovesQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetStakeMoves", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeSubnetStakeMoves(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        distinct_movers: 6,
        movements: 18,
        movements_per_mover: 3,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_movers: 6,
      movements: 18,
      movements_per_mover: 3,
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { distinct_movers: "nope" }]) {
      const card = normalizeSubnetStakeMoves(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.distinct_movers).toBe(0);
      expect(card.movements).toBe(0);
      expect(card.movements_per_mover).toBeNull();
      expect(card.observed_at).toBeNull();
    }
  });

  it("coerces a junk average to null (never NaN)", () => {
    const card = normalizeSubnetStakeMoves(7, {
      movements: 4,
      movements_per_mover: { avg: 1 },
    });
    expect(card.movements).toBe(4);
    expect(card.movements_per_mover).toBeNull();
  });
});

describe("subnetStakeMovesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", distinct_movers: 3, movements: 9 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/stake-moves",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.movements).toBe(9);
    expect(res.data.distinct_movers).toBe(3);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/stake-moves",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
