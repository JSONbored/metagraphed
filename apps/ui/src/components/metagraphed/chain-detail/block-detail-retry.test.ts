import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/metagraphed/client";
import {
  BLOCK_DETAIL_RETRY_COUNT,
  BLOCK_DETAIL_RETRY_DELAYS_MS,
  blockDetailRetryDelay,
  isBlockDetailUnavailable,
  shouldRetryBlockDetail,
} from "./block-detail-retry";

const pending = new ApiError("coverage gap", {
  status: 503,
  code: "block_detail_unavailable",
  url: "https://api.example.test/api/v1/blocks/42/extrinsics",
});

describe("newest block detail retry", () => {
  it("recognizes only the API's explicit temporary coverage state", () => {
    expect(isBlockDetailUnavailable(pending)).toBe(true);
    expect(
      isBlockDetailUnavailable(
        new ApiError("service unavailable", {
          status: 503,
          code: "data_tier_unavailable",
          url: "https://api.example.test/api/v1/blocks/42/extrinsics",
        }),
      ),
    ).toBe(false);
    expect(isBlockDetailUnavailable(new Error("coverage gap"))).toBe(false);
  });

  it("spends a bounded browser retry budget and never amplifies SSR", () => {
    expect(shouldRetryBlockDetail(0, pending, true)).toBe(true);
    expect(shouldRetryBlockDetail(BLOCK_DETAIL_RETRY_COUNT - 1, pending, true)).toBe(true);
    expect(shouldRetryBlockDetail(BLOCK_DETAIL_RETRY_COUNT, pending, true)).toBe(false);
    expect(shouldRetryBlockDetail(0, pending, false)).toBe(false);
  });

  it("does not retry unrelated failures even when their status is also 503", () => {
    const unrelated = new ApiError("upstream unavailable", {
      status: 503,
      code: "upstream_unavailable",
      url: "https://api.example.test/api/v1/blocks/42/extrinsics",
    });
    expect(shouldRetryBlockDetail(0, unrelated, true)).toBe(false);
  });

  it("backs off across the measured handoff window and caps later indexes", () => {
    expect(BLOCK_DETAIL_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(32_000);
    expect(BLOCK_DETAIL_RETRY_DELAYS_MS.map((_, index) => blockDetailRetryDelay(index))).toEqual(
      BLOCK_DETAIL_RETRY_DELAYS_MS,
    );
    expect(blockDetailRetryDelay(-1)).toBe(1_000);
    expect(blockDetailRetryDelay(99)).toBe(10_000);
  });
});
