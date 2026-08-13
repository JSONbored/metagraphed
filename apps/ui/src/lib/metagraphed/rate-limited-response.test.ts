import { describe, expect, it } from "vitest";

import { ApiError } from "./client";
import { RATE_LIMITED_RETRY_AFTER_SECONDS, rateLimitedResponse } from "./rate-limited-response";

const throttled = () =>
  new ApiError("Too many data API requests from this client; slow down.", {
    status: 429,
    code: "data_rate_limited",
    url: "/api/v1/blocks/8803541",
  });

describe("a throttled primary query answers 429, not 200 (#11000)", () => {
  it("carries the status a crawler acts on", () => {
    const res = rateLimitedResponse(throttled());
    expect(res?.status).toBe(429);
  });

  it("carries Retry-After, so the back-off is bounded and not guessed", () => {
    // The API's anonymous window is a fixed 60 s, so this is a fact about the
    // limiter rather than a hedge.
    expect(rateLimitedResponse(throttled())?.headers.get("retry-after")).toBe(
      String(RATE_LIMITED_RETRY_AFTER_SECONDS),
    );
  });

  it("is never stored — the next caller's budget is not this one's", () => {
    expect(rateLimitedResponse(throttled())?.headers.get("cache-control")).toBe("no-store");
  });

  it("serves a real HTML page, so a human does not get an empty 429", async () => {
    const res = rateLimitedResponse(throttled());
    expect(res?.headers.get("content-type")).toContain("text/html");
    const body = await res!.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toMatch(/rate-limited/i);
    // The copy must not claim a fault: that is the whole point of the change.
    expect(body).not.toMatch(/went wrong|didn't load|error/i);
  });
});

describe("it declines everything that is not a 429 (#11000)", () => {
  // The loader keeps its existing not-found and transient-failure handling
  // underneath this, so a helper that over-matched would silently convert a
  // missing entity — or an outage — into a throttling claim.
  it("passes through other API statuses", () => {
    for (const status of [0, 404, 500, 503]) {
      expect(
        rateLimitedResponse(new ApiError("nope", { status, url: "/api/v1/blocks/1" })),
        `status ${status}`,
      ).toBeNull();
    }
  });

  it("passes through a non-ApiError throw", () => {
    expect(rateLimitedResponse(new Error("boom"))).toBeNull();
    expect(rateLimitedResponse(undefined)).toBeNull();
    expect(rateLimitedResponse({ status: 429 })).toBeNull();
  });
});
