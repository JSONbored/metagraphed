// #8696: the alerting rule for the SafeMode monitor, tested without a chain.
//
// The edges ARE the feature. #8697's audit said SafeMode had "never been
// called" and proposed alerting on first use; re-running that census against
// the completed index found one call — block 4,222,830, FAILED, from an
// unprivileged signer. A monitor that fires on it teaches its reader to ignore
// it, so the rule keys on SUCCESS, and the historical failure has to stay
// visible in the summary without being alerted on.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  evaluateSafeMode,
  runSafeModeWatchdog,
} from "../src/safe-mode-watchdog.ts";

/** The one real SafeMode extrinsic on finney, as the index returns it. */
const HISTORICAL_FAILURE = {
  block_number: 4_222_830,
  call_function: "force_release_deposit",
  success: false,
  signer: "5H6tCSXfWreW",
};

describe("SafeMode alerting rule (#8696)", () => {
  test("the quiet chain is the steady state and alerts nothing", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [HISTORICAL_FAILURE],
    });
    assert.deepEqual(v.reasons, []);
    assert.equal(v.paused, false);
  });

  test("the known historical FAILURE is reported but never alerted on", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [HISTORICAL_FAILURE],
    });
    // Visible...
    assert.deepEqual(v.summary.known_failed, ["4222830:force_release_deposit"]);
    assert.equal(v.summary.safe_mode_extrinsics, 1);
    // ...and not a reason to wake anyone.
    assert.equal(v.summary.succeeded, 0);
    assert.deepEqual(v.reasons, []);
  });

  test("a SUCCESSFUL extrinsic alerts, naming block and signer", () => {
    const v = evaluateSafeMode({
      enteredUntil: null,
      extrinsics: [
        HISTORICAL_FAILURE,
        {
          block_number: 9_000_000,
          call_function: "enter",
          success: true,
          signer: null,
        },
      ],
    });
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /SUCCEEDED — block 9000000, enter, signer root/);
  });

  test("an ACTIVE pause alerts even with no extrinsic behind it", () => {
    // Safe mode can be entered by root with no signed SafeMode extrinsic ever
    // appearing, so storage is the authoritative signal — an extrinsic-only
    // monitor would miss exactly the case that matters most.
    const v = evaluateSafeMode({
      enteredUntil: "0x40e2010000000000",
      extrinsics: [],
    });
    assert.equal(v.paused, true);
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /SafeMode is ACTIVE/);
  });

  test("an empty storage value is not a pause", () => {
    // `null` is an unset key; "0x" is present-but-empty, which is not a block
    // number. Reading either as a pause would alert on a quiet chain forever.
    for (const enteredUntil of [null, "0x"]) {
      const v = evaluateSafeMode({ enteredUntil, extrinsics: [] });
      assert.equal(v.paused, false, `${enteredUntil} must not read as paused`);
      assert.deepEqual(v.reasons, []);
    }
  });

  // `fetchImpl` now serves the STORAGE read only -- the history half is
  // `readExtrinsics`, an in-process tier call rather than an HTTP hop (#10765).
  const storageReads = (result: unknown) =>
    (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
      })) as unknown as typeof fetch;

  test("a quiet chain reports a ran-and-found-nothing tick", async () => {
    // The measured path. Both reads injectable, because a branch that only
    // runs against a live chain is a branch nothing verifies.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: storageReads(null),
      readExtrinsics: async () => [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.equal(result.chain_paused, false);
    assert.equal(result.history_read, true);
  });

  test("an ACTIVE pause alerts through the runner", async () => {
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: storageReads("0x1234"),
      readExtrinsics: async () => [],
    });
    assert.equal(result.alerted, true);
    assert.equal(result.chain_paused, true);
  });

  test("a degraded extrinsics tier is UNREAD, not 'no activity'", async () => {
    // The false negative this monitor exists to avoid, unchanged in intent and
    // moved in mechanism (#10765). It used to fail the whole tick, which threw
    // away the pause check with it; now the history half alone goes null. What
    // must never happen either way is a degraded tier reading as a clean chain.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        })) as unknown as typeof fetch,
      readExtrinsics: async () => null,
    });
    assert.equal(result.history_read, false);
    assert.equal(
      result.succeeded,
      null,
      "a failed read must not count zero successes",
    );
    assert.equal(
      result.safe_mode_extrinsics,
      null,
      "nor zero extrinsics -- that is an assertion it did not earn",
    );
  });

  test("the cron is wired: the schedule reaches the watchdog", async () => {
    // A cron entry with no dispatch branch falls through to the health prober
    // and checks nothing -- silently.
    const { default: worker } = await import("../workers/api.ts");
    const { SAFE_MODE_WATCHDOG_CRON } = await import("../workers/config.ts");
    const result = (await worker.scheduled(
      { cron: SAFE_MODE_WATCHDOG_CRON, scheduledTime: Date.now() } as never,
      { SAFE_MODE_RPC_URL: "http://127.0.0.1:1/unreachable" } as never,
      { waitUntil: () => {} } as never,
    )) as Record<string, unknown>;
    assert.equal(
      result.reason,
      "unreachable",
      "the SafeMode cron did not reach runSafeModeWatchdog -- an unmatched " +
        "cron falls through to the health prober and checks nothing",
    );
  });

  test("the cron constant matches a wrangler schedule", async () => {
    const { readFileSync } = await import("node:fs");
    const { SAFE_MODE_WATCHDOG_CRON } = await import("../workers/config.ts");
    assert.ok(
      readFileSync("wrangler.jsonc", "utf8").includes(
        `"${SAFE_MODE_WATCHDOG_CRON}"`,
      ),
      `wrangler.jsonc declares no "${SAFE_MODE_WATCHDOG_CRON}" cron, so this watchdog never runs`,
    );
  });

  test("a failed PRIMARY read reports unreachable, never 'quiet'", async () => {
    // The storage read is the authoritative "are we paused right now" signal.
    // Without it there is no verdict to give, so both of its failure modes
    // have to surface as a failed TICK -- a monitor that reports "no SafeMode
    // activity" because it could not look is worse than one that reports
    // nothing at all.
    const ok = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const cases: [string, () => Response][] = [
      ["RPC returns a non-200", () => ok({}, 503)],
      [
        "RPC returns a JSON-RPC error",
        () => ok({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }),
      ],
    ];
    for (const [name, impl] of cases) {
      const result = await runSafeModeWatchdog(null, {
        fetchImpl: (async () => impl()) as unknown as typeof fetch,
        readExtrinsics: async () => [],
      });
      assert.equal(result.ok, false, name);
      assert.equal(result.reason, "unreachable", name);
    }
  });

  // #10765. THE REGRESSION THIS FILE EXISTS TO HOLD FROM NOW ON. For a week
  // every hourly tick returned unreachable because the history read 522'd on a
  // self-fetch, and the pause check -- which had SUCCEEDED on every one of
  // those ticks -- was discarded with it. A chain pause would not have been
  // reported. The two halves fail independently now.
  test("a failed history read keeps the pause verdict", async () => {
    const paused = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
        {
          status: 200,
        },
      )) as unknown as typeof fetch;
    for (const [name, readExtrinsics] of [
      ["the tier declined", async () => null],
      [
        "the reader threw",
        async () => {
          throw new Error("r2 sql: HTTP 500");
        },
      ],
    ] as const) {
      const result = await runSafeModeWatchdog(null, {
        fetchImpl: paused,
        readExtrinsics: readExtrinsics as never,
      });
      assert.equal(result.ok, true, name);
      assert.equal(result.alerted, true, `${name}: the pause still alerts`);
      assert.equal(result.chain_paused, true, name);
      assert.equal(result.history_read, false, name);
    }
  });

  test("history that could not be read counts nothing, rather than zero", async () => {
    // `succeeded: 0` from a monitor that failed to look asserts that no
    // SafeMode call has ever landed. Null is the only honest value.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        })) as unknown as typeof fetch,
      readExtrinsics: async () => null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.history_read, false);
    assert.equal(result.safe_mode_extrinsics, null);
    assert.equal(result.succeeded, null);
    assert.equal(result.known_failed, null);
  });

  test("an empty history IS an answer, and counts zero", async () => {
    // The distinction the null case above turns on: the tier answering "the
    // decoded range holds no SafeMode call" is a real reading, not a decline.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        })) as unknown as typeof fetch,
      readExtrinsics: async () => [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.history_read, true);
    assert.equal(result.safe_mode_extrinsics, 0);
    assert.equal(result.succeeded, 0);
  });

  test("a non-Error thrown upstream still yields a readable detail", async () => {
    // fetch implementations can reject with a string. `String(err)` rather than
    // `err.message` keeps the tick reportable instead of throwing inside the
    // handler that exists to catch throws.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async () => {
        throw "socket closed";
      }) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "socket closed");
  });
});

// ---- reporting (#9440) ----
//
// This watchdog reported on NO channel. It computed `reasons` correctly and
// returned them to handleScheduled, whose return value workers/api.entry.ts
// discards -- so the chain entering SafeMode, the most consequential event this
// repo watches for, was detected every tick and told to nobody.
describe("the watchdog's own reporting", () => {
  function captureSpy() {
    const captures: Record<string, unknown>[] = [];
    return {
      captures,
      recordExceptionEvent: (async (_env: unknown, event: unknown) => {
        captures.push(event as Record<string, unknown>);
        return true;
      }) as never,
    };
  }

  const quietChain = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
      status: 200,
    })) as unknown as typeof fetch;

  const pausedChain = (async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }), {
      status: 200,
    })) as unknown as typeof fetch;

  /** The history half answering normally: no SafeMode call in range. */
  const quietHistory = async () => [];

  test("an ACTIVE pause is reported, not merely returned", async () => {
    const spy = captureSpy();
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: pausedChain,
      readExtrinsics: quietHistory,
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.equal(result.alerted, true);
    assert.equal(spy.captures.length, 1);
    assert.equal(spy.captures[0].route, "watchdog:safe-mode");
    assert.equal(spy.captures[0].errorCode, "safe_mode_active");
    assert.match((spy.captures[0].error as Error).message, /SafeMode watchdog/);
  });

  test("a quiet chain reports nothing", async () => {
    const spy = captureSpy();
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: quietChain,
      readExtrinsics: quietHistory,
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.equal(result.alerted, false);
    assert.deepEqual(spy.captures, [], "a quiet chain pages no one");
  });

  test("a blind history half reports on the MONITOR's channel, not the chain's", async () => {
    // It has to be reported -- "the history read has been failing for a week"
    // is precisely the fact that went unnoticed while the 522 ran (#10765).
    // But it carries watchdog_unreachable, not safe_mode_active: nothing about
    // the chain was observed, and filing it as a chain event would be a false
    // statement on the alert channel that exists for real pauses.
    const spy = captureSpy();
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: quietChain,
      readExtrinsics: async () => null,
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false, "a blind half is not a chain alert");
    assert.equal(spy.captures.length, 1);
    assert.equal(spy.captures[0].errorCode, "watchdog_unreachable");
    assert.equal(spy.captures[0].route, "watchdog:safe-mode");
  });

  test("a pause AND a blind history report on both channels", async () => {
    const spy = captureSpy();
    await runSafeModeWatchdog(null, {
      fetchImpl: pausedChain,
      readExtrinsics: async () => null,
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.deepEqual(
      spy.captures.map((c) => c.errorCode).sort(),
      ["safe_mode_active", "watchdog_unreachable"],
      "neither report may swallow the other",
    );
  });

  test("an unreachable tick reports itself", async () => {
    // The monitor's silence is indistinguishable from "the chain is fine",
    // and that equivalence is the whole reason it exists -- so a tick that
    // cannot run has to say so rather than returning quietly.
    const spy = captureSpy();
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async () => {
        throw new Error("rpc unreachable");
      }) as unknown as typeof fetch,
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unreachable");
    assert.equal(spy.captures.length, 1);
    assert.equal(spy.captures[0].errorCode, "watchdog_unreachable");
  });

  test("a capture that fails never breaks the tick", async () => {
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: pausedChain,
      readExtrinsics: quietHistory,
      recordExceptionEvent: (async () => {
        throw new Error("posthog unreachable");
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });
});

// ---- the rule's third state, at the pure-function level (#10765) ----
describe("history that could not be read is a state of its own", () => {
  test("null extrinsics never alert, and never assert a count", () => {
    const v = evaluateSafeMode({ enteredUntil: null, extrinsics: null });
    assert.deepEqual(v.reasons, [], "a blind read is not a chain event");
    assert.equal(v.summary.history_read, false);
    assert.equal(v.summary.safe_mode_extrinsics, null);
    assert.equal(v.summary.succeeded, null);
    assert.equal(v.summary.known_failed, null);
  });

  test("the pause verdict is computed from storage alone", () => {
    // The regression: for a week the pause check succeeded on every tick and
    // was discarded because the history read threw beside it.
    const v = evaluateSafeMode({
      enteredUntil: "0x40e2010000000000",
      extrinsics: null,
    });
    assert.equal(v.paused, true);
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], /SafeMode is ACTIVE/);
  });

  test("an empty list still reads as a real, counted answer", () => {
    const v = evaluateSafeMode({ enteredUntil: null, extrinsics: [] });
    assert.equal(v.summary.history_read, true);
    assert.equal(v.summary.safe_mode_extrinsics, 0);
    assert.equal(v.summary.succeeded, 0);
    assert.deepEqual(v.summary.known_failed, []);
  });
});

test("a capture that fails on the BLIND-HALF report never breaks the tick", async () => {
  // Same contract as the pause-report capture beside it: PostHog being
  // unreachable must not turn one missed report into a failed tick.
  const result = await runSafeModeWatchdog(null, {
    fetchImpl: (async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
        status: 200,
      })) as unknown as typeof fetch,
    readExtrinsics: async () => null,
    recordExceptionEvent: (async () => {
      throw new Error("posthog unreachable");
    }) as never,
  });
  assert.equal(result.ok, true);
  assert.equal(result.history_read, false);
});
