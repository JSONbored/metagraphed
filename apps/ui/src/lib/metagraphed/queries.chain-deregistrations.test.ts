import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainDeregistrationsQuery, normalizeChainDeregistrations } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/deregistrations",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainDeregistrationsQuery(window as "7d" | "30d" | undefined, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainDeregistrations", () => {
  it("passes a well-formed leaderboard through", () => {
    expect(
      normalizeChainDeregistrations({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: {
          distinct_deregistered_hotkeys: 5,
          deregistrations: 70,
          deregistrations_per_hotkey: 14,
        },
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
          {
            netuid: 1,
            distinct_deregistered_hotkeys: 4,
            deregistrations: 40,
            deregistrations_per_hotkey: 10,
          },
          {
            netuid: 2,
            distinct_deregistered_hotkeys: 2,
            deregistrations: 30,
            deregistrations_per_hotkey: 15,
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: {
        distinct_deregistered_hotkeys: 5,
        deregistrations: 70,
        deregistrations_per_hotkey: 14,
      },
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
        {
          netuid: 1,
          distinct_deregistered_hotkeys: 4,
          deregistrations: 40,
          deregistrations_per_hotkey: 10,
        },
        {
          netuid: 2,
          distinct_deregistered_hotkeys: 2,
          deregistrations: 30,
          deregistrations_per_hotkey: 15,
        },
      ],
    });
  });

  it("degrades a cold / junk store to a schema-stable zeroed leaderboard", () => {
    for (const raw of [{}, null, "x", { subnet_count: "nope" }]) {
      const card = normalizeChainDeregistrations(raw);
      expect(card.subnet_count).toBe(0);
      expect(card.network.deregistrations).toBe(0);
      expect(card.network.distinct_deregistered_hotkeys).toBe(0);
      expect(card.network.deregistrations_per_hotkey).toBeNull();
      expect(card.subnets).toEqual([]);
    }
  });

  it("drops malformed subnet rows", () => {
    const card = normalizeChainDeregistrations({
      subnet_count: 2,
      network: {},
      subnets: [{ netuid: "bad" }, { netuid: 3, deregistrations: 5 }],
    });
    expect(card.subnets).toEqual([
      {
        netuid: 3,
        distinct_deregistered_hotkeys: 0,
        deregistrations: 5,
        deregistrations_per_hotkey: null,
      },
    ]);
  });
});

describe("chainDeregistrationsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches with window and limit params", async () => {
    resolveWith({ subnet_count: 0, network: {}, subnets: [] });
    await runQuery("30d", 50);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/deregistrations", {
      params: { window: "30d", limit: 50 },
      signal: expect.any(AbortSignal),
    });
  });

  it("defaults to 7d and limit 100", async () => {
    resolveWith({ subnet_count: 0, network: {}, subnets: [] });
    await runQuery();
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/deregistrations", {
      params: { window: "7d", limit: 100 },
      signal: expect.any(AbortSignal),
    });
  });
});
