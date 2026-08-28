import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { economicsQuery, subnetProfileQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

async function runQuery<T>(opts: {
  queryFn?: (context: never) => T | Promise<T>;
  queryKey: readonly unknown[];
}): Promise<T> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never);
}

describe("route performance projections", () => {
  beforeEach(() => mockedApiFetch.mockReset());

  it("sends the compact economics field list to the API", async () => {
    mockedApiFetch.mockResolvedValue({
      data: { subnets: [{ netuid: 1, name: "Apex", emission_share: 0.1, ignored: "large" }] },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/economics",
    });

    const result = await runQuery(economicsQuery({ fields: "identity" }));

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/economics",
      expect.objectContaining({
        params: { fields: "netuid,name,emission_share" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.data).toEqual([{ netuid: 1, name: "Apex", emission_share: 0.1 }]);
  });

  it("preserves every field requested by the directory projection", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {
        subnets: [
          {
            netuid: 19,
            name: "Compute Lab",
            emission_share: 0.0082,
            total_stake_alpha: 1_234,
            alpha_price_tao: 0.042,
            alpha_price_change_7d: 2.5,
            alpha_price_change_1m: 9.1,
            validator_count: 64,
            subnet_volume_tao: 88,
            ignored: "large",
          },
        ],
      },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/economics",
    });

    const result = await runQuery(economicsQuery({ fields: "directory" }));

    expect(result.data).toEqual([
      {
        netuid: 19,
        name: "Compute Lab",
        emission_share: 0.0082,
        total_stake_alpha: 1_234,
        alpha_price_tao: 0.042,
        alpha_price_change_7d: 2.5,
        alpha_price_change_1m: 9.1,
        validator_count: 64,
        subnet_volume_tao: 88,
      },
    ]);
  });

  it("requests only profile metadata and cannot dehydrate duplicate collections", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {
        profile: { netuid: 19, name: "Compute Lab", surface_count: 37 },
        surfaces: [{ id: "duplicate-surface" }],
        endpoints: [{ id: "duplicate-endpoint" }],
        candidate_surfaces: [{ id: "duplicate-candidate" }],
      },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/subnets/19/profile",
    });

    const result = await runQuery(subnetProfileQuery(19));

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/19/profile",
      expect.objectContaining({
        params: { sections: "profile,subnet" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.data).toMatchObject({ netuid: 19, name: "Compute Lab", surface_count: 37 });
    expect(result.data.surfaces).toBeUndefined();
    expect(result.data.endpoints).toBeUndefined();
    expect(result.data.candidate_surfaces).toBeUndefined();
  });
});
