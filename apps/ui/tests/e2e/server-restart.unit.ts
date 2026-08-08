// Unit coverage for the e2e harness's restart tolerance (#10013).
//
// This helper decides whether the suite is TRUSTWORTHY: too eager and it hides
// a real breakage behind a slow pass, too timid and main goes red on unchanged
// code. Both directions are asserted here, with a fake page rather than a
// browser -- `.unit.ts` so Playwright's testMatch does not collect it (see
// vitest.config.ts).

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __resetServerPresumedGone,
  gotoThroughRestart,
  isServerUnavailable,
  SERVER_RESTART_BUDGET_MS,
} from "./server-restart.ts";

// The presumed-gone latch is module state by design (one Playwright worker =
// one process), so each case starts from a clean one.
beforeEach(() => __resetServerPresumedGone());

type FakePage = {
  goto: ReturnType<typeof vi.fn>;
  waitForTimeout: ReturnType<typeof vi.fn>;
};

/**
 * A page whose goto throws the given errors in order, then succeeds.
 *
 * `waitMs` makes the stubbed waitForTimeout actually sleep, so a test can let a
 * real budget elapse across several retries -- the latch only arms after more
 * than one attempt, which a zero-budget call can never reach.
 */
function fakePage(failures: Error[], waitMs = 0): FakePage {
  let call = 0;
  return {
    goto: vi.fn(async () => {
      const failure = failures[call];
      call += 1;
      if (failure) throw failure;
      return { status: () => 200 };
    }),
    waitForTimeout: vi.fn(async () => await new Promise((r) => setTimeout(r, waitMs))),
  };
}

const refused = () =>
  new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:8080/chain/extrinsics");

describe("isServerUnavailable", () => {
  test("recognises the restart window, in the shapes Chromium reports it", () => {
    for (const message of [
      "net::ERR_CONNECTION_REFUSED at http://localhost:8080/x",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_EMPTY_RESPONSE",
      "connect ECONNREFUSED 127.0.0.1:8080",
      "socket hang up",
    ]) {
      expect(isServerUnavailable(new Error(message)), message).toBe(true);
    }
  });

  test("does not claim a real failure is a restart", () => {
    // If any of these were treated as "server down", a genuine breakage would
    // be retried until the budget expired and then reported as a timeout --
    // the failure mode this helper exists to avoid creating.
    for (const message of [
      "page.goto: Timeout 30000ms exceeded",
      "net::ERR_TOO_MANY_REDIRECTS",
      "net::ERR_NAME_NOT_RESOLVED",
      "Target page, context or browser has been closed",
      "expect(received).toBe(expected)",
    ]) {
      expect(isServerUnavailable(new Error(message)), message).toBe(false);
    }
    expect(isServerUnavailable(undefined)).toBe(false);
    expect(isServerUnavailable({})).toBe(false);
  });
});

describe("gotoThroughRestart", () => {
  test("navigates once when the server is up", async () => {
    const page = fakePage([]);
    await gotoThroughRestart(page as never, "/chain/extrinsics");
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.waitForTimeout).not.toHaveBeenCalled();
  });

  test("waits out a restart and returns the eventual response", async () => {
    const page = fakePage([refused(), refused(), refused()]);
    const response = await gotoThroughRestart(page as never, "/x");
    expect(page.goto).toHaveBeenCalledTimes(4);
    expect((response as { status: () => number }).status()).toBe(200);
  });

  test("rethrows a non-restart error on the FIRST attempt", async () => {
    // The safety property: a real failure must not be masked into a slow pass.
    const page = fakePage([new Error("net::ERR_TOO_MANY_REDIRECTS")]);
    await expect(gotoThroughRestart(page as never, "/x")).rejects.toThrow("ERR_TOO_MANY_REDIRECTS");
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test("gives up once the budget is spent rather than hanging", async () => {
    const page = fakePage(Array.from({ length: 500 }, refused));
    // A budget of 0 means the deadline has already passed on the first catch.
    await expect(gotoThroughRestart(page as never, "/x", undefined, 0)).rejects.toThrow(
      "ERR_CONNECTION_REFUSED",
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test("the default budget covers the supervisor's own restart path", () => {
    // serve-e2e.ts polls up to 15s for the port to free before respawning
    // wrangler, and booting a Worker takes longer still. A budget under that
    // would time out on exactly the restarts this exists to survive.
    expect(SERVER_RESTART_BUDGET_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("presumed-gone latch", () => {
  test("stops re-waiting the full budget once the server is confirmed gone", async () => {
    // Without the latch, a dead server costs every remaining test the whole
    // budget -- measured at 45s each by killing the port holder mid-run.
    // 30ms per retry against a 50ms budget: attempt 1 fails, one retry fails,
    // and the third finds the deadline passed. The latch arms only after MORE
    // than one attempt, so a zero-budget call could never reach it.
    const first = fakePage(Array.from({ length: 500 }, refused), 30);
    await expect(gotoThroughRestart(first as never, "/x", undefined, 50)).rejects.toThrow();
    expect(first.goto.mock.calls.length).toBeGreaterThan(1);

    const second = fakePage(Array.from({ length: 500 }, refused));
    await expect(gotoThroughRestart(second as never, "/y")).rejects.toThrow(
      "ERR_CONNECTION_REFUSED",
    );
    expect(
      second.goto,
      "the second navigation must fail on its first attempt, not retry",
    ).toHaveBeenCalledTimes(1);
    expect(second.waitForTimeout).not.toHaveBeenCalled();
  });

  test("a single refused navigation that then succeeds does NOT latch", async () => {
    // Latching on a transient refusal would disable the whole mitigation after
    // the first restart it successfully rode out.
    const page = fakePage([refused()]);
    await gotoThroughRestart(page as never, "/x");

    const later = fakePage([refused()]);
    await gotoThroughRestart(later as never, "/y");
    expect(later.goto).toHaveBeenCalledTimes(2);
  });
});
