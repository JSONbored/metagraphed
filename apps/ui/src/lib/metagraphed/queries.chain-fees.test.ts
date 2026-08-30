import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainFeesQuery } from "./queries";
import { runQuery } from "./run-query";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

describe("chainFeesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("retains the signed-extrinsic denominator used by window fee averages", async () => {
    mockedApiFetch.mockResolvedValue({
      data: {
        observed_at: "2026-08-29T00:00:00Z",
        day_count: 1,
        daily: [
          {
            day: "2026-08-28",
            extrinsic_count: 12,
            signed_extrinsic_count: 10,
            total_fee_tao: 2,
            avg_fee_tao: 0.2,
            total_tip_tao: 0.1,
            avg_tip_tao: 0.01,
          },
        ],
        top_fee_payers: [],
      },
      meta: {} as ApiResult<unknown>["meta"],
      url: "/api/v1/chain/fees",
    });

    const result = await runQuery(chainFeesQuery("7d"));

    expect(result.data.daily[0]).toMatchObject({
      extrinsic_count: 12,
      signed_extrinsic_count: 10,
      total_fee_tao: 2,
    });
  });
});
