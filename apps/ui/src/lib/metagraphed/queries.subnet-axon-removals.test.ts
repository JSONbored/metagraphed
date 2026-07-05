import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetAxonRemovals, subnetAxonRemovalsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/axon-removals",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetAxonRemovalsQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetAxonRemovals", () => {
  it("passes a well-formed card through", () => {
    expect(
      normalizeSubnetAxonRemovals(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        observed_at: "2026-07-01T00:00:00Z",
        distinct_removers: 4,
        removals: 9,
        removals_per_remover: 2.25,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_removers: 4,
      removals: 9,
      removals_per_remover: 2.25,
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed card", () => {
    for (const raw of [{}, null, "x", { distinct_removers: "nope" }]) {
      const card = normalizeSubnetAxonRemovals(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.distinct_removers).toBe(0);
      expect(card.removals).toBe(0);
      expect(card.removals_per_remover).toBeNull();
      expect(card.observed_at).toBeNull();
    }
  });

  it("coerces a junk average to null (never NaN)", () => {
    const card = normalizeSubnetAxonRemovals(7, {
      removals: 3,
      removals_per_remover: { avg: 1 },
    });
    expect(card.removals).toBe(3);
    expect(card.removals_per_remover).toBeNull();
  });
});

describe("subnetAxonRemovalsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", distinct_removers: 2, removals: 5 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/axon-removals",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.removals).toBe(5);
    expect(res.data.distinct_removers).toBe(2);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/axon-removals",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});
