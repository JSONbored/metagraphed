import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainServingQuery, normalizeChainServing } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/serving",
  });
}

async function runQuery(window?: string, limit?: number) {
  const opts = chainServingQuery(window as "7d" | "30d" | undefined, limit);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeChainServing", () => {
  it("passes a well-formed leaderboard through", () => {
    expect(
      normalizeChainServing({
        schema_version: 1,
        window: "7d",
        observed_at: "2026-07-01T00:00:00Z",
        subnet_count: 2,
        network: {
          distinct_servers: 8,
          announcements: 120,
          announcements_per_server: 15,
        },
        intensity_distribution: null,
        subnets: [
          {
            netuid: 1,
            distinct_servers: 5,
            announcements: 80,
            announcements_per_server: 16,
          },
          {
            netuid: 19,
            distinct_servers: 3,
            announcements: 40,
            announcements_per_server: 13.33,
          },
        ],
      }),
    ).toEqual({
      schema_version: 1,
      window: "7d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 2,
      network: {
        distinct_servers: 8,
        announcements: 120,
        announcements_per_server: 15,
      },
      intensity_distribution: null,
      subnets: [
        {
          netuid: 1,
          distinct_servers: 5,
          announcements: 80,
          announcements_per_server: 16,
        },
        {
          netuid: 19,
          distinct_servers: 3,
          announcements: 40,
          announcements_per_server: 13.33,
        },
      ],
    });
  });

  it("zeroes a cold or malformed payload", () => {
    expect(normalizeChainServing(null)).toEqual({
      schema_version: 1,
      window: null,
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_servers: 0,
        announcements: 0,
        announcements_per_server: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });
});

describe("chainServingQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("fetches and normalizes the network-wide serving leaderboard", async () => {
    resolveWith({
      schema_version: 1,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      subnet_count: 1,
      network: { distinct_servers: 4, announcements: 60, announcements_per_server: 15 },
      intensity_distribution: null,
      subnets: [
        { netuid: 8, distinct_servers: 4, announcements: 60, announcements_per_server: 15 },
      ],
    });

    const res = await runQuery("30d", 50);
    expect(mockedApiFetch).toHaveBeenCalledWith("/api/v1/chain/serving", {
      params: { window: "30d", limit: 50 },
      signal: expect.any(AbortSignal),
    });
    expect(res.data.subnets).toHaveLength(1);
    expect(res.data.network.announcements).toBe(60);
  });
});
