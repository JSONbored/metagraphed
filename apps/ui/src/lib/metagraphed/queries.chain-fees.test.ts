import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainFeesQuery } from "./queries";
import { runQuery } from "./run-query";
import {
  feeDayWindow,
  summarizeFeeWindow,
} from "@/components/metagraphed/chain-hub/chain-hub-logic";

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
  it("preserves nullable daily amounts through the query and closed-day summary", async () => {
    for (const missing of ["total_fee_tao", "total_tip_tao", "signed_extrinsic_count"] as const) {
      mockedApiFetch.mockResolvedValue({
        data: {
          observed_at: "2026-10-15T12:00:00Z",
          daily: [
            {
              day: "2026-10-13",
              extrinsic_count: 10,
              signed_extrinsic_count: 10,
              total_fee_tao: 10,
              total_tip_tao: 1,
              [missing]: null,
            },
            {
              day: "2026-10-14",
              extrinsic_count: 1,
              signed_extrinsic_count: 1,
              total_fee_tao: 2,
              total_tip_tao: 2,
            },
          ],
        },
        meta: {},
        url: "/api/v1/chain/fees",
      });
      const result = await runQuery(chainFeesQuery("7d"));
      const closed = feeDayWindow(
        result.data.daily,
        result.data.observed_at,
        Date.parse("2026-10-15T13:00:00Z"),
      ).closed;
      expect(closed).toHaveLength(2);
      expect(closed[0]![missing]).toBeNull();
      const summary = summarizeFeeWindow(closed)!;
      expect(summary.totalFeeTao).toBe(missing === "total_fee_tao" ? null : 12);
      expect(summary.totalTipTao).toBe(missing === "total_tip_tao" ? null : 3);
      expect(summary.averageFeeTao).toBe(missing === "total_tip_tao" ? 12 / 11 : null);
    }
  });
});
