import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainRegistrationsQuery, normalizeChainRegistrations } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/registrations",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainRegistrationsQuery(window as "7d" | "30d" | undefined, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainRegistrations", () => {
  it("passes a well-formed leaderboard through", () => {
    expect(
      normalizeChainRegistrations({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: {
          distinct_registrants: 5,
          registrations: 70,
          registrations_per_registrant: 14,
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
            distinct_registrants: 4,
            registrations: 40,
            registrations_per_registrant: 10,
          },
          {
            netuid: 2,
            distinct_registrants: 2,
            registrations: 30,
            registrations_per_registrant: 15,
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: {
        distinct_registrants: 5,
        registrations: 70,
        registrations_per_registrant: 14,
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
          distinct_registrants: 4,
          registrations: 40,
          registrations_per_registrant: 10,
        },
        {
          netuid: 2,
          distinct_registrants: 2,
          registrations: 30,
          registrations_per_registrant: 15,
        },
      ],
    });
  });

  it("zeroes a cold or malformed payload", () => {
    expect(normalizeChainRegistrations(null)).toEqual({
      schema_version: 1,
      window: null,
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_registrants: 0,
        registrations: 0,
        registrations_per_registrant: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });
});

describe("chainRegistrationsQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches and normalizes the network-wide registrations leaderboard", async () => {
    resolveWith({
      schema_version: 1,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 1,
      network: { distinct_registrants: 3, registrations: 9, registrations_per_registrant: 3 },
      intensity_distribution: null,
      subnets: [
        { netuid: 8, distinct_registrants: 3, registrations: 9, registrations_per_registrant: 3 },
      ],
    });

    const res = await runQuery("30d", 50);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/registrations", {
      params: { window: "30d", limit: 50 },
      signal: expect.any(AbortSignal),
    });
    expect(res.data.subnets).toHaveLength(1);
    expect(res.data.network.registrations).toBe(9);
  });
});
