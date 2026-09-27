import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./client";
import { shouldRetryApiQuery } from "./query-retry";

const apiError = (status: number, code?: string) =>
  new ApiError("request failed", { status, code, url: "https://api.metagraph.sh/api/v1/subnets" });

describe("shouldRetryApiQuery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never retries SSR requests", () => {
    vi.stubGlobal("window", undefined);
    expect(shouldRetryApiQuery(0, apiError(503))).toBe(false);
    expect(shouldRetryApiQuery(0, new Error("connection failed"))).toBe(false);
  });

  it.each([0, 400, 401, 403, 404, 408, 422, 429])(
    "does not amplify rejected or offline requests with status %s",
    (status) => {
      vi.stubGlobal("window", {});
      expect(shouldRetryApiQuery(0, apiError(status))).toBe(false);
    },
  );

  it.each(["artifact_not_found", "data_tier_unavailable"])(
    "preserves terminal handling for %s even on successful HTTP responses",
    (code) => {
      vi.stubGlobal("window", {});
      expect(shouldRetryApiQuery(0, apiError(200, code))).toBe(false);
    },
  );

  it("does not retry cancelled queries", () => {
    vi.stubGlobal("window", {});
    expect(shouldRetryApiQuery(0, new DOMException("cancelled", "AbortError"))).toBe(false);
  });

  it.each([apiError(500), apiError(503), new Error("temporary failure")])(
    "retains bounded browser retries for transient failures",
    (error) => {
      vi.stubGlobal("window", {});
      expect(shouldRetryApiQuery(0, error)).toBe(true);
      expect(shouldRetryApiQuery(2, error)).toBe(true);
      expect(shouldRetryApiQuery(3, error)).toBe(false);
    },
  );
});
