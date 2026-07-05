import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetWeights, subnetWeightsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/weights",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetWeightsQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetWeights", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeSubnetWeights(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        distinct_setters: 8,
        weight_sets: 24,
        sets_per_setter: 3,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_setters: 8,
      weight_sets: 24,
      sets_per_setter: 3,
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { distinct_setters: "nope" }]) {
      const card = normalizeSubnetWeights(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.distinct_setters).toBe(0);
      expect(card.weight_sets).toBe(0);
      expect(card.sets_per_setter).toBeNull();
      expect(card.observed_at).toBeNull();
    }
  });

  it("coerces a junk average to null (never NaN)", () => {
    const card = normalizeSubnetWeights(7, {
      weight_sets: 5,
      sets_per_setter: { avg: 1 },
    });
    expect(card.weight_sets).toBe(5);
    expect(card.sets_per_setter).toBeNull();
  });
});

describe("subnetWeightsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", distinct_setters: 4, weight_sets: 12 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/weights",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.weight_sets).toBe(12);
    expect(res.data.distinct_setters).toBe(4);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/weights",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
