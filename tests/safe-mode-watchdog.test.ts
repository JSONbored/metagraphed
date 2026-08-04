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

  test("a quiet chain reports a ran-and-found-nothing tick", async () => {
    // The measured path. Injectable fetch, because a branch that only runs
    // against a live chain is a branch nothing verifies.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async (url: string) =>
        String(url).includes("/api/v1/extrinsics")
          ? new Response(
              JSON.stringify({ ok: true, data: { extrinsics: [] } }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
              {
                status: 200,
              },
            )) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, false);
    assert.equal(result.chain_paused, false);
  });

  test("an ACTIVE pause alerts through the runner", async () => {
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async (url: string) =>
        String(url).includes("/api/v1/extrinsics")
          ? new Response(
              JSON.stringify({ ok: true, data: { extrinsics: [] } }),
              { status: 200 },
            )
          : new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
              { status: 200 },
            )) as unknown as typeof fetch,
    });
    assert.equal(result.alerted, true);
    assert.equal(result.chain_paused, true);
  });

  test("a degraded extrinsics tier is an ERROR, not 'no activity'", async () => {
    // The false negative this monitor exists to avoid: an ok:false envelope
    // carries an empty list, which would otherwise read as a clean chain.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async (url: string) =>
        String(url).includes("/api/v1/extrinsics")
          ? new Response(JSON.stringify({ ok: false, data: null }), {
              status: 200,
            })
          : new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
              {
                status: 200,
              },
            )) as unknown as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unreachable");
    assert.equal(
      result.alerted,
      undefined,
      "a failed read must not read as quiet",
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

  test("every upstream failure mode reports unreachable, never 'quiet'", async () => {
    // Each of these is a way the two reads can fail while still returning a
    // response. All of them must surface as a failed TICK -- a monitor that
    // reports "no SafeMode activity" because it could not look is worse than
    // one that reports nothing at all.
    const ok = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    const rpcOk = { jsonrpc: "2.0", id: 1, result: null };
    const cases: [string, (url: string) => Response][] = [
      [
        "RPC returns a non-200",
        (url) =>
          url.includes("/api/v1/extrinsics")
            ? ok({ ok: true, data: { extrinsics: [] } })
            : ok({}, 503),
      ],
      [
        "RPC returns a JSON-RPC error",
        (url) =>
          url.includes("/api/v1/extrinsics")
            ? ok({ ok: true, data: { extrinsics: [] } })
            : ok({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }),
      ],
      [
        "the extrinsics route returns a non-200",
        (url) => (url.includes("/api/v1/extrinsics") ? ok({}, 502) : ok(rpcOk)),
      ],
    ];
    for (const [name, impl] of cases) {
      const result = await runSafeModeWatchdog(null, {
        fetchImpl: (async (url: string) =>
          impl(String(url))) as unknown as typeof fetch,
      });
      assert.equal(result.ok, false, name);
      assert.equal(result.reason, "unreachable", name);
    }
  });

  test("an ok envelope with no extrinsics array is treated as empty, not as a crash", async () => {
    // `data.extrinsics` absent on an ok:true envelope is a shape question, not
    // a trust question -- the envelope asserted success, so an absent list is
    // an empty list.
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: (async (url: string) =>
        String(url).includes("/api/v1/extrinsics")
          ? new Response(JSON.stringify({ ok: true, data: {} }), {
              status: 200,
            })
          : new Response(
              JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }),
              {
                status: 200,
              },
            )) as unknown as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.safe_mode_extrinsics, 0);
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

  const quietChain = (async (url: string) =>
    String(url).includes("/api/v1/extrinsics")
      ? new Response(JSON.stringify({ ok: true, data: { extrinsics: [] } }), {
          status: 200,
        })
      : new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        })) as unknown as typeof fetch;

  const pausedChain = (async (url: string) =>
    String(url).includes("/api/v1/extrinsics")
      ? new Response(JSON.stringify({ ok: true, data: { extrinsics: [] } }), {
          status: 200,
        })
      : new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1234" }),
          { status: 200 },
        )) as unknown as typeof fetch;

  test("an ACTIVE pause is reported, not merely returned", async () => {
    const spy = captureSpy();
    const result = await runSafeModeWatchdog(null, {
      fetchImpl: pausedChain,
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
      recordExceptionEvent: spy.recordExceptionEvent,
    });
    assert.equal(result.alerted, false);
    assert.deepEqual(spy.captures, [], "a quiet chain pages no one");
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
      recordExceptionEvent: (async () => {
        throw new Error("posthog unreachable");
      }) as never,
    });
    assert.equal(result.ok, true);
    assert.equal(result.alerted, true);
  });
});
