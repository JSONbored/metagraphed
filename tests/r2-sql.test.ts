// src/r2-sql.ts is a SERVING path over the chain lakehouse, so these tests
// care about two things above all: that no failure mode can turn a slow
// archive query into a broken page, and that nothing user-controlled can be
// interpolated into a query (R2 SQL has no bound parameters, so the safe-
// literal guards are the whole defence).
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import {
  currentR2SqlFailureGeneration,
  R2_SQL_OUTAGE_COOLDOWN_MS,
  R2_SQL_OUTAGE_STREAK,
  isExpectedR2SqlFailure,
  r2SqlOutageRemainingMs,
  isR2SqlConfigured,
  r2SqlQuery,
  r2SqlQueryKind,
  r2SqlQueryShape,
  r2SqlRateLimitRemainingMs,
  R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS,
  R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV,
  R2_SQL_MAX_BODY_BYTES_DEFAULT,
  R2_SQL_MAX_BODY_BYTES_ENV,
  R2_SQL_TOKEN_ENV,
  safeBlockNumber,
  safeHexLiteral,
  safeSs58Literal,
  safeNameLiteral,
} from "../src/r2-sql.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { mockEnv } from "./row-type.ts";
import {
  AccountEventsRowSchema,
  BlocksRowSchema,
} from "../generated/lakehouse/schemas.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };

// The account rate-limit breaker is module-global by design, and several tests
// here answer 429 deliberately (the attribution suite asserts `http_429`). File
// scope rather than per-describe: any test that provokes a 429 now leaves the
// breaker open, and a suppressed query is silent, so a leak would surface as an
// unrelated test failing on a capture that never happened.
afterEach(() => resetModuleState());

// A REAL Response, not a `{ ok, status, json }` stand-in. The client reads
// through a byte cap now (R2_SQL_MAX_BODY_BYTES), which needs `res.body` to be
// an actual stream -- a hand-rolled double with only `json()` would take the
// uncapped path and leave every test here exercising a branch production never
// runs. `ok` is derived from `status` because a Response derives it too; every
// call site that passed `false` paired it with a 4xx/5xx anyway.
function jsonFetch(body: unknown, _ok = true, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("isR2SqlConfigured", () => {
  test("requires a non-empty token", () => {
    assert.equal(isR2SqlConfigured(mockEnv(TOKEN)), true);
    assert.equal(isR2SqlConfigured(mockEnv()), false);
    assert.equal(
      isR2SqlConfigured(mockEnv({ [R2_SQL_TOKEN_ENV]: "  " })),
      false,
    );
    assert.equal(isR2SqlConfigured(null), false);
  });
});

describe("safe literals — the only defence against injection here", () => {
  test("block numbers: real non-negative integers only", () => {
    assert.equal(safeBlockNumber(8755000), 8755000);
    assert.equal(safeBlockNumber("8755000"), 8755000);
    for (const bad of [
      -1,
      1.5,
      NaN,
      Infinity,
      "abc",
      null,
      undefined,
      true,
      false,
      "",
      "  ",
      "-5",
      "1.5",
      "1; DROP TABLE",
      // All digits, but beyond Number.MAX_SAFE_INTEGER -- would lose precision
      // and address the wrong block.
      "99999999999999999999",
    ]) {
      assert.equal(safeBlockNumber(bad), null, `rejected: ${String(bad)}`);
    }
  });

  test("hex literals: 0x-prefixed hex only, lowercased", () => {
    assert.equal(safeHexLiteral("0xABCdef"), "0xabcdef");
    for (const bad of [
      "abcdef",
      "0x",
      "0xzz",
      "0x123'--",
      "'; DROP TABLE chain.blocks; --",
      42,
      null,
    ]) {
      assert.equal(safeHexLiteral(bad), null, `rejected: ${String(bad)}`);
    }
  });
});

describe("r2SqlQuery", () => {
  test("unconfigured returns null WITHOUT calling out or counting a failure", async () => {
    const { impl, calls } = jsonFetch({});
    const before = currentR2SqlFailureGeneration();
    const rows = await r2SqlQuery(mockEnv(), "SELECT 1", { fetch: impl });
    assert.equal(rows, null);
    assert.equal(calls.length, 0);
    assert.equal(
      currentR2SqlFailureGeneration(),
      before,
      "no token is a deployment shape, not a fault",
    );
  });

  test("returns rows, and posts the query to the warehouse endpoint", async () => {
    const { impl, calls } = jsonFetch({
      success: true,
      result: { rows: [{ block_number: 8755095 }] },
    });
    const rows = await r2SqlQuery(
      mockEnv(TOKEN),
      "SELECT block_number FROM chain.blocks LIMIT 1",
      { fetch: impl },
    );
    assert.deepEqual(rows, [{ block_number: 8755095 }]);
    assert.match(calls[0]!.url, /r2-sql\/query\/metagraphed-lakehouse$/);
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>).authorization,
      "Bearer cfut_test",
    );
    const sent = JSON.parse(String(calls[0]!.init.body));
    assert.equal(sent.warehouse, "metagraphed-lakehouse");
    assert.match(sent.query, /FROM chain\.blocks/);
  });

  test("an empty result is [] — 'no such block' is an ANSWER, not a failure", async () => {
    const { impl } = jsonFetch({ success: true, result: { rows: [] } });
    const before = currentR2SqlFailureGeneration();
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl });
    assert.deepEqual(rows, []);
    assert.equal(currentR2SqlFailureGeneration(), before);
  });

  test("a missing rows field still yields [] rather than null", async () => {
    const { impl } = jsonFetch({ success: true, result: {} });
    assert.deepEqual(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl }),
      [],
    );
  });

  test("HTTP error degrades to null and bumps the generation", async () => {
    const { impl } = jsonFetch({}, false, 503);
    const before = currentR2SqlFailureGeneration();
    const captured: { route?: string }[] = [];
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async (_e: unknown, ev: { route?: string }) => {
        captured.push(ev);
        return true;
      }) as never,
    });
    assert.equal(rows, null);
    assert.equal(currentR2SqlFailureGeneration(), before + 1);
    assert.equal(captured[0]?.route, "r2-sql");
  });

  test("a success:false body degrades to null with the engine's message", async () => {
    const { impl } = jsonFetch({
      success: false,
      errors: [{ code: 40006, message: "warehouse does not exist" }],
    });
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async () => true) as never,
    });
    assert.equal(rows, null);
  });

  test("a success:false body with no error detail still degrades cleanly", async () => {
    const { impl } = jsonFetch({ success: false });
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("a thrown transport error is contained", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("account and warehouse overrides are honoured", async () => {
    const { impl, calls } = jsonFetch({ success: true, result: { rows: [] } });
    await r2SqlQuery(
      mockEnv({
        ...TOKEN,
        R2_SQL_ACCOUNT_ID: "acct123",
        R2_SQL_WAREHOUSE: "other-house",
      }),
      "SELECT 1",
      { fetch: impl },
    );
    assert.match(
      calls[0]!.url,
      /accounts\/acct123\/r2-sql\/query\/other-house$/,
    );
  });

  test("a stuck query is aborted by the timeout, not left pinning the request", async () => {
    // A fetch that never settles on its own: only the abort can end it.
    //
    // The abort is DRIVEN, not awaited (#9123). This used to pass
    // `timeoutMs: 5` and rely on a real setTimeout, which hung in CI's
    // shared-registry pass until vitest killed it at 30s -- a timeout test
    // failing by timing out. Nothing else could end the promise, so a timer
    // that did not fire was an indefinite hang rather than a wrong answer.
    let fire: (() => void) | null = null;
    let signalledMs: number | null = null;
    let aborted = false;
    const impl = (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;

    const pending = r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      timeoutMs: 5,
      recordException: (async () => true) as never,
      scheduleAbort: (abort, ms) => {
        signalledMs = ms;
        fire = abort;
        return () => {};
      },
    });
    // The query is genuinely in flight until the abort is fired -- proving the
    // stub really does hang, so the assertion below is about the abort and not
    // about some other early return.
    assert.equal(aborted, false, "not aborted before the timer fires");
    assert.equal(signalledMs, 5, "the ceiling is handed to the scheduler");
    (fire as unknown as () => void)();
    // Asserted BEFORE the await: AbortController fires its listeners
    // synchronously, so a broken abort fails here with a message instead of
    // hanging until the suite's timeout. Nothing else can settle this promise,
    // so without this line a regression is indistinguishable from a slow test
    // -- which is exactly how the flake this replaces presented.
    assert.equal(aborted, true, "the request was actually aborted");

    assert.equal(
      await pending,
      null,
      "an aborted query degrades like any other failure",
    );
  });

  test("a non-Error rejection still degrades cleanly", async () => {
    const impl = (async () => {
      throw "plain string";
    }) as unknown as typeof fetch;
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("a success:false body with an error lacking a code omits the suffix", async () => {
    const { impl } = jsonFetch({
      success: false,
      errors: [{ message: "nope" }],
    });
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      }),
      null,
    );
  });

  test("uses the real exception recorder when none is injected", async () => {
    const impl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    // No POSTHOG_PROJECT_TOKEN here, so the real recorder is a safe no-op --
    // this exercises the default rather than the injected seam.
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", { fetch: impl });
    assert.equal(rows, null);
  });

  test("falls back to the real global fetch when none is injected", async () => {
    const realFetch = globalThis.fetch;
    let hit = false;
    globalThis.fetch = (async () => {
      hit = true;
      return new Response(
        JSON.stringify({ success: true, result: { rows: [{ n: 1 }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    try {
      const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1");
      assert.equal(hit, true);
      assert.deepEqual(rows, [{ n: 1 }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("a rejected query says WHY the engine refused it", () => {
  // R2 SQL answers a refusal with a numbered, self-explaining message. Only
  // the non-2xx arm threw it away (the success:false arm above always
  // surfaced it), and that asymmetry is what made the account summary card's
  // outage opaque: one query tripped `40015: scan budget exceeded: scanning
  // too much data for count(DISTINCT) without GROUP BY`, the whole loader
  // declined, and every account got a zero card while the log said only
  // "HTTP 422".
  function textFetch(text: string | (() => Promise<string>), status = 422) {
    const impl = (async () => ({
      ok: false,
      status,
      text: typeof text === "function" ? text : async () => text,
    })) as unknown as typeof fetch;
    return impl;
  }

  async function errorFrom(impl: typeof fetch): Promise<string> {
    const lines: string[] = [];
    const spy = console.error;
    console.error = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        recordException: (async () => true) as never,
      });
    } finally {
      console.error = spy;
    }
    return lines.join(" ");
  }

  test("the engine's numbered message reaches the logged error", async () => {
    const logged = await errorFrom(
      textFetch(
        "40015: scan budget exceeded: scanning too much data for" +
          " count(DISTINCT) without GROUP BY",
      ),
    );
    assert.match(logged, /HTTP 422/);
    assert.match(logged, /40015/);
    assert.match(logged, /count\(DISTINCT\) without GROUP BY/);
  });

  test("an empty or unreadable body still reports the status", async () => {
    assert.match(await errorFrom(textFetch("")), /r2 sql: HTTP 422/);
    assert.match(
      await errorFrom(
        textFetch(async () => {
          throw new Error("stream broken");
        }, 500),
      ),
      /r2 sql: HTTP 500/,
    );
  });

  test("a long body is bounded rather than logged whole", async () => {
    const logged = await errorFrom(textFetch("x".repeat(5000)));
    assert.ok(logged.length < 400, String(logged.length));
  });
});

// The account-wide 429 breaker (#9465). 80014 is a per-ACCOUNT limit, so the
// question these tests answer is not "did one query fail" -- that was always
// handled -- but "did the NEXT one stop firing into an exhausted budget".
describe("r2SqlQuery account rate-limit breaker", () => {
  function statusFetch(status: number) {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(url);
      return {
        ok: status < 400,
        status,
        text: async () =>
          `{"code":80014,"message":"Account rate limit exceeded"}`,
        json: async () => ({ success: true, result: { rows: [] } }),
      };
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  /** Silences the module's console.error so a deliberate failure does not print
   * through the suite; returns what it swallowed. */
  async function quietly<T>(run: () => Promise<T>): Promise<T> {
    const spy = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = spy;
    }
  }

  const noCapture = { recordException: (async () => true) as never };

  test("a 429 opens the cooldown; the NEXT query never reaches the network", async () => {
    const { impl, calls } = statusFetch(429);
    let clock = 1_000;
    const deps = { fetch: impl, now: () => clock, ...noCapture };

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps));
    assert.equal(
      calls.length,
      1,
      "the first query is the one that discovers it",
    );
    assert.equal(
      r2SqlRateLimitRemainingMs(clock),
      R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS,
    );

    clock += 5_000;
    const rows = await quietly(() =>
      r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps),
    );
    assert.equal(rows, null, "still the same degrade-to-empty contract");
    assert.equal(
      calls.length,
      1,
      "suppressed queries must not spend the account budget they are waiting on",
    );
  });

  test("a suppressed query records NO exception, but still marks the answer degraded", async () => {
    const { impl } = statusFetch(429);
    let clock = 1_000;
    let captured = 0;
    const deps = {
      fetch: impl,
      now: () => clock,
      recordException: (async () => {
        captured += 1;
        return true;
      }) as never,
    };

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps));
    assert.equal(
      captured,
      1,
      "the rejection that opened the breaker reports once",
    );

    clock += 5_000;
    const before = currentR2SqlFailureGeneration();
    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps));
    assert.equal(
      captured,
      1,
      "one $exception per cooldown, not one per suppressed query -- the storm this exists to stop",
    );
    assert.equal(
      currentR2SqlFailureGeneration(),
      before + 1,
      "a suppressed answer is still a degraded one and must never be cached as real",
    );
  });

  test("the caller still learns WHY, through the same onError seam", async () => {
    const { impl } = statusFetch(429);
    let clock = 1_000;
    const details: string[] = [];
    const deps = {
      fetch: impl,
      now: () => clock,
      onError: (detail: string) => details.push(detail),
      ...noCapture,
    };

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps));
    clock += 5_000;
    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps));

    assert.match(details[0]!, /HTTP 429/);
    assert.match(details[1]!, /account rate limited/);
    assert.match(details[1]!, /55000ms/, "and how long is left on it");
  });

  test("a throwing onError never turns a declined query into a thrown one", async () => {
    const { impl } = statusFetch(429);
    const clock = 1_000;
    const deps = {
      fetch: impl,
      now: () => clock,
      onError: () => {
        throw new Error("the caller's own reporting is broken");
      },
      ...noCapture,
    };

    assert.equal(
      await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps)),
      null,
    );
    // And on the suppressed path too, which routes through the same helper.
    assert.equal(
      await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps)),
      null,
    );
  });

  test("once the cooldown expires, querying resumes", async () => {
    const { impl, calls } = statusFetch(429);
    let clock = 1_000;
    const deps = { fetch: impl, now: () => clock, ...noCapture };

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps));
    clock += R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS;
    assert.equal(r2SqlRateLimitRemainingMs(clock), 0);

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps));
    assert.equal(calls.length, 2, "the breaker must not latch shut");
  });

  test("only 429 opens it — a 422 scan-budget rejection must not mute the tier", async () => {
    const { impl, calls } = statusFetch(422);
    const clock = 1_000;
    const deps = { fetch: impl, now: () => clock, ...noCapture };

    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 1", deps));
    assert.equal(r2SqlRateLimitRemainingMs(clock), 0);
    await quietly(() => r2SqlQuery(mockEnv(TOKEN), "SELECT 2", deps));
    assert.equal(
      calls.length,
      2,
      "one bad query is not evidence the account budget is gone",
    );
  });

  test("the cooldown length is configurable, and an explicit 0 disables the breaker", async () => {
    const { impl, calls } = statusFetch(429);
    const clock = 1_000;

    const tuned = mockEnv({
      ...TOKEN,
      [R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV]: "5000",
    });
    await quietly(() =>
      r2SqlQuery(tuned, "SELECT 1", {
        fetch: impl,
        now: () => clock,
        ...noCapture,
      }),
    );
    assert.equal(r2SqlRateLimitRemainingMs(clock), 5_000);

    resetModuleState();
    const off = mockEnv({ ...TOKEN, [R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV]: "0" });
    await quietly(() =>
      r2SqlQuery(off, "SELECT 1", {
        fetch: impl,
        now: () => clock,
        ...noCapture,
      }),
    );
    assert.equal(
      r2SqlRateLimitRemainingMs(clock),
      0,
      "an operator can turn it off",
    );
    await quietly(() =>
      r2SqlQuery(off, "SELECT 2", {
        fetch: impl,
        now: () => clock,
        ...noCapture,
      }),
    );
    assert.equal(calls.length, 3);
  });

  test("an unset, blank or malformed cooldown all take the default", async () => {
    const clock = 1_000;
    for (const raw of [undefined, "", "   ", "not-a-number", "-1"]) {
      resetModuleState();
      const { impl } = statusFetch(429);
      const env = mockEnv(
        raw === undefined
          ? { ...TOKEN }
          : { ...TOKEN, [R2_SQL_RATE_LIMIT_COOLDOWN_MS_ENV]: raw },
      );
      await quietly(() =>
        r2SqlQuery(env, "SELECT 1", {
          fetch: impl,
          now: () => clock,
          ...noCapture,
        }),
      );
      assert.equal(
        r2SqlRateLimitRemainingMs(clock),
        R2_SQL_RATE_LIMIT_COOLDOWN_DEFAULT_MS,
        `${String(raw)} must not silently disable the breaker`,
      );
    }
  });

  test("remaining time reads the real clock when no time is supplied", () => {
    assert.equal(r2SqlRateLimitRemainingMs(), 0);
  });

  test("an unconfigured deployment is never suppressed by the breaker", async () => {
    const { impl, calls } = statusFetch(429);
    const clock = 1_000;
    await quietly(() =>
      r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: impl,
        now: () => clock,
        ...noCapture,
      }),
    );
    // No token: the unconfigured branch returns first, so the breaker's state
    // is irrelevant and no failure is counted against it.
    const before = currentR2SqlFailureGeneration();
    assert.equal(
      await r2SqlQuery(mockEnv(), "SELECT 2", { fetch: impl }),
      null,
    );
    assert.equal(currentR2SqlFailureGeneration(), before);
    assert.equal(calls.length, 1);
  });
});

// R2 SQL takes NO bound parameters, so every value that reaches a query is inlined
// into a string. These two guards are therefore the whole injection boundary for the
// lakehouse readers, and they were exercised only indirectly through their callers.
describe("the inline-literal guards", () => {
  test("safeSs58Literal accepts real addresses at every length Substrate uses", () => {
    for (const ok of [
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u", // 48
      "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      "1".repeat(47),
      "1".repeat(49),
    ]) {
      assert.equal(safeSs58Literal(ok), ok, ok.slice(0, 12));
    }
  });

  test("safeSs58Literal refuses anything that could close the quote", () => {
    for (const bad of [
      "'; DROP TABLE chain.account_events --",
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u' OR '1'='1",
      "5E2LP6' UNION SELECT 1 --",
      "1".repeat(46), // too short
      "1".repeat(50), // too long
      "", // empty
      "5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ0I", // 0 and I are not base58
      null,
      42,
      {},
      ["5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u"],
    ]) {
      assert.equal(
        safeSs58Literal(bad),
        null,
        JSON.stringify(bad)?.slice(0, 40),
      );
    }
  });

  test("safeNameLiteral accepts the identifiers the chain actually emits", () => {
    for (const ok of [
      "Transfer",
      "StakeAdded",
      "SubtensorModule",
      "a",
      "A_1",
      "a".repeat(64),
    ]) {
      assert.equal(safeNameLiteral(ok), ok, ok.slice(0, 20));
    }
  });

  test("safeNameLiteral refuses quotes, spaces, leading digits and overlong names", () => {
    for (const bad of [
      "Transfer'; DROP TABLE x --",
      "Stake Added", // a space
      "1Transfer", // must start with a letter
      "_Transfer",
      "Transfer-Kind", // hyphen is not in the set
      "a".repeat(65), // one past the ceiling
      "",
      null,
      7,
    ]) {
      assert.equal(
        safeNameLiteral(bad),
        null,
        JSON.stringify(bad)?.slice(0, 40),
      );
    }
  });
});

// #9459: every failure here captured under one flat `route: "r2-sql"`, so a
// timeout, a 429, a 422 scan-budget rejection and a 400 shared one fingerprint
// and the inbox could not say which query was slow. The fix has to buy that
// attribution WITHOUT splitting the fingerprint, because the storm guard
// windows per fingerprint -- N fingerprints at one event per window each is N
// times the billable volume against the tightest budget this project has.
describe("query attribution (#9459)", () => {
  /** Capture the one exception event a failed query records. */
  async function captureFailure(
    sql: string,
    fetchImpl: typeof fetch,
    extra: Record<string, unknown> = {},
  ) {
    const captured: Record<string, unknown>[] = [];
    await r2SqlQuery(mockEnv(TOKEN), sql, {
      fetch: fetchImpl,
      recordException: (async (_e: unknown, ev: Record<string, unknown>) => {
        captured.push(ev);
        return true;
      }) as never,
      ...extra,
    });
    return captured[0]!;
  }

  test("the fingerprint input is unchanged — attribution is properties only", async () => {
    // The whole cost argument in one assertion: two queries that differ in
    // every way still carry the SAME `route`, which is what
    // recordExceptionEvent builds $exception_fingerprint from. If a future
    // change moves query_kind into `route` to "improve" grouping, this fails.
    // The 429 goes LAST on purpose: it opens the account rate-limit breaker,
    // which suppresses the next query in this isolate outright — so a 429 first
    // would leave `b` with no capture to assert on at all.
    const a = await captureFailure(
      "SELECT 1 FROM chain.blocks",
      jsonFetch({}, false, 500).impl,
    );
    const b = await captureFailure(
      "SELECT netuid FROM chain_testnet.account_events WHERE observed_at >= 5",
      jsonFetch({}, false, 429).impl,
    );
    assert.equal(a.route, "r2-sql");
    assert.equal(b.route, "r2-sql");
    assert.notEqual(a.queryKind, b.queryKind);
    assert.notEqual(a.errorCode, b.errorCode);
  });

  test("an HTTP rejection is classified by its status", async () => {
    const captured = await captureFailure(
      "SELECT 1 FROM chain.blocks",
      jsonFetch({}, false, 429).impl,
    );
    // The 429 storm of 2026-08-04 was indistinguishable from the steady
    // timeout leak in the inbox; this is the field that separates them.
    assert.equal(captured.errorCode, "http_429");
    assert.equal(captured.queryKind, "chain.blocks");
  });

  test("an engine rejection carries its numbered code", async () => {
    const captured = await captureFailure(
      "SELECT count(DISTINCT coldkey) FROM chain.account_events",
      jsonFetch({
        success: false,
        errors: [
          { code: 40015, message: "scan budget exceeded: count(DISTINCT)" },
        ],
      }).impl,
    );
    assert.equal(captured.errorCode, "engine_40015");
  });

  test("an engine rejection with no code is `engine`, not `engine_undefined`", async () => {
    const captured = await captureFailure(
      "SELECT 1 FROM chain.blocks",
      jsonFetch({ success: false, errors: [{ message: "nope" }] }).impl,
    );
    assert.equal(captured.errorCode, "engine");
  });

  test("a transport throw is `transport` — no response was ever inspected", async () => {
    const captured = await captureFailure(
      "SELECT 1 FROM chain.blocks",
      (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    );
    assert.equal(captured.errorCode, "transport");
  });

  test("an abort is `timeout`, read off the signal rather than the message", async () => {
    // The abort's text is the runtime's, not ours, and has changed spelling
    // across workerd versions -- so the classifier must not sniff it. Same
    // driven-abort shape as the timeout test above (#9123): the stubbed fetch
    // only settles on abort, so nothing else can end this promise.
    let fire: (() => void) | undefined;
    const impl = (async (_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      })) as unknown as typeof fetch;
    const pending = captureFailure("SELECT 1 FROM chain.blocks", impl, {
      scheduleAbort: (abort: () => void) => {
        fire = abort;
        return () => {};
      },
    });
    (fire as unknown as () => void)();
    assert.equal((await pending).errorCode, "timeout");
  });

  test("the shape names the exact query with its literals collapsed", async () => {
    const captured = await captureFailure(
      `SELECT netuid, COUNT(*) AS n FROM chain.account_events` +
        ` WHERE coldkey = '5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F'` +
        ` AND observed_at >= 1754352000000 GROUP BY netuid`,
      jsonFetch({}, false, 500).impl,
    );
    assert.equal(
      captured.queryShape,
      "SELECT netuid, COUNT(*) AS n FROM chain.account_events" +
        " WHERE coldkey = ? AND observed_at >= ? GROUP BY netuid",
    );
    // The address the caller looked up is gone; the query that was slow is not.
    assert.equal(
      String(captured.queryShape).includes("5EYCAe5"),
      false,
      "a caller-supplied address must not ride out on a telemetry property",
    );
  });
});

describe("r2SqlQueryKind — the bounded half of the attribution", () => {
  test("names the qualified lakehouse table", () => {
    assert.equal(
      r2SqlQueryKind("SELECT * FROM chain.account_events WHERE x = 1"),
      "chain.account_events",
    );
    assert.equal(
      r2SqlQueryKind("SELECT * FROM chain_testnet.blocks"),
      "chain_testnet.blocks",
    );
  });

  test("takes the FIRST FROM, so a subquery reports the real table", () => {
    // loadValidatorNominatorsColdTier's true-count read: the outer FROM is a
    // derived table with no name worth reporting, the inner one is the answer.
    assert.equal(
      r2SqlQueryKind(
        "SELECT count(*) AS c FROM (SELECT coldkey FROM chain.account_events" +
          " WHERE observed_at >= 1 GROUP BY coldkey)",
      ),
      "chain.account_events",
    );
  });

  test("matches case-insensitively and accepts an unqualified table", () => {
    assert.equal(r2SqlQueryKind("select n from blocks"), "blocks");
  });

  test("reports `unknown` rather than nothing when there is no FROM", () => {
    // Visibly "we could not tell", never confusable with a capture that
    // predates attribution altogether.
    assert.equal(r2SqlQueryKind("SELECT 1"), "unknown");
    assert.equal(r2SqlQueryKind(""), "unknown");
  });
});

describe("r2SqlQueryShape — the precise half of the attribution", () => {
  test("collapses string and numeric literals and flattens whitespace", () => {
    assert.equal(
      r2SqlQueryShape(
        "SELECT *\n  FROM chain.blocks\n  WHERE block_number = 8755000\n" +
          "    AND hash = '0xdeadbeef'",
      ),
      "SELECT * FROM chain.blocks WHERE block_number = ? AND hash = ?",
    );
  });

  test("collapses a float, and a string literal that contains digits", () => {
    assert.equal(
      r2SqlQueryShape("SELECT x FROM t WHERE a > 1.5 AND b = 'sn74 2026'"),
      "SELECT x FROM t WHERE a > ? AND b = ?",
    );
  });

  test("keeps identifiers that merely contain digits", () => {
    // `net_flow_7d` and `ss58` are diagnostic content, not literals -- the
    // same reason normalizeExceptionMessage refuses to be a blanket strip.
    assert.equal(
      r2SqlQueryShape("SELECT ss58, net_flow_7d FROM chain.account_events"),
      "SELECT ss58, net_flow_7d FROM chain.account_events",
    );
  });
});

// ─── #9900: capacity failures are counted, not billed as errors ─────────────

describe("isExpectedR2SqlFailure (#9900)", () => {
  test("capacity conditions are expected", () => {
    for (const code of ["timeout", "http_429", "rate_limited"]) {
      assert.equal(isExpectedR2SqlFailure(code), true, code);
    }
  });

  test("correctness failures are NOT expected -- they are somebody's bug", () => {
    // http_422 is the load-bearing case: a scan-budget or malformed-query
    // rejection means a query in this repo needs fixing, and the error inbox
    // is exactly where that belongs.
    for (const code of [
      "http_422",
      "http_500",
      "engine_40006",
      "engine",
      "transport",
      "",
    ]) {
      assert.equal(isExpectedR2SqlFailure(code), false, code);
    }
  });
});

describe("r2SqlQuery marks capacity failures expected (#9900)", () => {
  test("a 429 is recorded as an expected condition, with attribution intact", async () => {
    const { impl } = jsonFetch({}, false, 429);
    const captured: {
      route?: string;
      errorCode?: string;
      expected?: boolean;
    }[] = [];
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async (_e: unknown, ev: Record<string, unknown>) => {
        captured.push(ev);
        return true;
      }) as never,
    });
    assert.equal(rows, null);
    assert.equal(captured[0]?.expected, true);
    assert.equal(captured[0]?.errorCode, "http_429");
    assert.equal(
      captured[0]?.route,
      "r2-sql",
      "route is unchanged, so the condition stays queryable exactly as before",
    );
  });

  test("a 422 stays a real exception", async () => {
    const { impl } = jsonFetch({}, false, 422);
    const captured: { expected?: boolean; errorCode?: string }[] = [];
    await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: impl,
      recordException: (async (_e: unknown, ev: Record<string, unknown>) => {
        captured.push(ev);
        return true;
      }) as never,
    });
    assert.equal(captured[0]?.expected, false);
    assert.equal(captured[0]?.errorCode, "http_422");
  });
});

describe("the upstream-outage breaker (#10741)", () => {
  const SQL = "SELECT 1";
  function res(status: number) {
    return {
      ok: status < 400,
      status,
      json: async () => ({ result: [], success: true }),
      text: async () => "",
    } as unknown as Response;
  }

  test("a FIRST 500 still throws — it may be our query that broke the engine", async () => {
    const clock = 1_000;
    let calls = 0;
    const out = await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: (async () => {
        calls += 1;
        return res(500);
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    assert.equal(out, null);
    assert.equal(calls, 1, "the first 5xx is SENT, not suppressed");
    assert.equal(r2SqlOutageRemainingMs(clock), 0, "one 500 is a blip");
  });

  test("a SECOND consecutive 500 opens the breaker", async () => {
    const clock = 1_000;
    const fetchImpl = (async () => res(500)) as unknown as typeof fetch;
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    assert.equal(r2SqlOutageRemainingMs(clock), R2_SQL_OUTAGE_COOLDOWN_MS);
  });

  test("queries behind the open breaker are NOT sent, and do not throw", async () => {
    // The 1,546 that followed the first said nothing it had not.
    const clock = 1_000;
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return res(500);
    }) as unknown as typeof fetch;
    for (let i = 0; i < 5; i += 1) {
      await r2SqlQuery(mockEnv(TOKEN), SQL, {
        fetch: fetchImpl,
        now: () => clock,
      });
    }
    assert.equal(
      sent,
      R2_SQL_OUTAGE_STREAK,
      "only the streak reached upstream",
    );
  });

  test("the breaker reopens the tier once the cooldown passes", async () => {
    let clock = 1_000;
    const fetchImpl = (async () => res(500)) as unknown as typeof fetch;
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    assert.ok(r2SqlOutageRemainingMs(clock) > 0);
    clock += R2_SQL_OUTAGE_COOLDOWN_MS + 1;
    assert.equal(r2SqlOutageRemainingMs(clock), 0, "cooldowns expire");
  });

  test("a NON-5xx response ends the streak — the far side is answering", async () => {
    // A 429 or a 422 both prove the engine is alive, so the streak is over,
    // not merely paused.
    const clock = 1_000;
    let n = 0;
    const fetchImpl = (async () =>
      res([500, 422, 500][n++] ?? 500)) as unknown as typeof fetch;
    for (let i = 0; i < 3; i += 1) {
      await r2SqlQuery(mockEnv(TOKEN), SQL, {
        fetch: fetchImpl,
        now: () => clock,
      });
    }
    assert.equal(
      r2SqlOutageRemainingMs(clock),
      0,
      "500, 422, 500 is never two IN A ROW",
    );
  });

  test("a fetch that resolves to nothing is not counted as a 5xx", async () => {
    // `res?.status ?? 0` is reachable: a transport-level failure can hand back
    // no response at all, and that is a `transport` fault, not an upstream 5xx.
    const clock = 1_000;
    const fetchImpl = (async () => undefined) as unknown as typeof fetch;
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    await r2SqlQuery(mockEnv(TOKEN), SQL, {
      fetch: fetchImpl,
      now: () => clock,
    });
    assert.equal(
      r2SqlOutageRemainingMs(clock),
      0,
      "no response is not evidence the engine returned 5xx",
    );
  });

  test("a suppressed query is a usage event; the 5xx itself is not", async () => {
    // The distinction the whole fix rests on: the follow-ups stop being billed
    // as errors, while a first 500 still reaches the inbox.
    assert.equal(isExpectedR2SqlFailure("upstream_down"), true);
    assert.equal(isExpectedR2SqlFailure("http_500"), false);
  });
});

describe("a row limit is not a byte limit (#11000)", () => {
  // Keeps these assertions about the READ, not about telemetry.
  const noCapture = { recordException: (async () => true) as never };
  // 2026-08-12: `TypeError: Memory limit exceeded before EOF` from
  //   SELECT block_number, ..., call_args, observed_at FROM chain.extrinsics
  //   WHERE signer = ? ORDER BY ... LIMIT ?
  // The LIMIT bounds ROWS. `call_args` has no width -- one set_weights carries
  // a weight per UID -- so a bounded page is an unbounded body. An OOM is not
  // a decline: it is raised by the runtime and it kills the ISOLATE, taking
  // every unrelated request sharing it, which is the one failure this module's
  // header promises cannot happen.
  const streamOf = (chunks: string[], status = 200) =>
    (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks)
              controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          },
        }),
        { status },
      )) as unknown as typeof fetch;

  test("a body over the cap is declined, not buffered", async () => {
    // 3 x 8 bytes against a 16-byte cap: refused on the chunk that crosses it,
    // never assembled.
    const impl = streamOf(["12345678", "12345678", "12345678"]);
    const rows = await r2SqlQuery(
      mockEnv({ ...TOKEN, [R2_SQL_MAX_BODY_BYTES_ENV]: "16" }),
      "SELECT call_args FROM chain.extrinsics LIMIT 200",
      { fetch: impl, ...noCapture },
    );
    assert.equal(
      rows,
      null,
      "a declined read degrades like every other failure",
    );
  });

  test("a body UNDER the cap still parses -- the guard is not a blanket refusal", async () => {
    const body = JSON.stringify({
      success: true,
      result: { rows: [{ n: 7 }] },
    });
    const rows = await r2SqlQuery(
      mockEnv({
        ...TOKEN,
        [R2_SQL_MAX_BODY_BYTES_ENV]: String(body.length + 1),
      }),
      "SELECT 1",
      { fetch: streamOf([body]), ...noCapture },
    );
    assert.deepEqual(rows, [{ n: 7 }]);
  });

  test("the cap counts BYTES RECEIVED, not Content-Length", async () => {
    // A chunked response carries no length, and a body that lies about its
    // length is exactly the one worth stopping. Split so no single chunk
    // exceeds the cap -- only the running total does.
    const impl = streamOf(["aaaa", "bbbb", "cccc", "dddd", "eeee"]);
    assert.equal(
      await r2SqlQuery(
        mockEnv({ ...TOKEN, [R2_SQL_MAX_BODY_BYTES_ENV]: "12" }),
        "SELECT 1",
        { fetch: impl, ...noCapture },
      ),
      null,
    );
  });

  test("`0` disables the cap -- an operator can open a valve they judge wrong", async () => {
    const body = JSON.stringify({
      success: true,
      result: { rows: [{ n: 1 }] },
    });
    const rows = await r2SqlQuery(
      mockEnv({ ...TOKEN, [R2_SQL_MAX_BODY_BYTES_ENV]: "0" }),
      "SELECT 1",
      { fetch: streamOf([body]), ...noCapture },
    );
    assert.deepEqual(
      rows,
      [{ n: 1 }],
      "0 must mean off, not 'reject everything'",
    );
  });

  test("an unset knob takes the default rather than disabling the cap", async () => {
    // The failure direction that matters: an absent env var must not read as 0.
    assert.ok(R2_SQL_MAX_BODY_BYTES_DEFAULT > 0);
    const rows = await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
      fetch: streamOf([
        JSON.stringify({ success: true, result: { rows: [{ n: 2 }] } }),
      ]),
      ...noCapture,
    });
    assert.deepEqual(rows, [{ n: 2 }]);
  });

  test("a non-JSON body is a decline, not a throw into the caller", async () => {
    assert.equal(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT 1", {
        fetch: streamOf(["<html>gateway</html>"]),
        ...noCapture,
      }),
      null,
    );
  });
});

describe("a lakehouse read is VALIDATED, not cast (#11000)", () => {
  const noCapture = { recordException: (async () => true) as never };
  const streamOf = (payload: unknown) =>
    (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  // `generated/lakehouse/types.ts` gives every read a row TYPE, and
  // `r2SqlQuery<BlocksRow>(...)` is a cast -- nothing checks the engine
  // answered those columns with those types. `generated/lakehouse/schemas.ts`
  // is the runtime half, generated from the same catalog snapshot.
  test("a row whose column violates the catalog is refused, not served", async () => {
    const rows = await r2SqlQuery(
      mockEnv(TOKEN),
      "SELECT block_number FROM chain.blocks LIMIT 1",
      {
        // block_number is a `long`; a string is a row the catalog cannot emit.
        fetch: streamOf({
          success: true,
          result: { rows: [{ block_number: "not-a-height" }] },
        }),
        rowSchema: BlocksRowSchema,
        ...noCapture,
      },
    );
    assert.equal(rows, null, "a corrupt row degrades like any other failure");
  });

  test("a legal row still passes -- the guard is not a blanket refusal", async () => {
    assert.deepEqual(
      await r2SqlQuery(
        mockEnv(TOKEN),
        "SELECT block_number FROM chain.blocks",
        {
          fetch: streamOf({
            success: true,
            result: { rows: [{ block_number: 8_810_877 }] },
          }),
          rowSchema: BlocksRowSchema,
          ...noCapture,
        },
      ),
      [{ block_number: 8_810_877 }],
    );
  });

  test("an AGGREGATE alias survives -- most reads select things that are not columns", async () => {
    // The failure this nearly shipped with: Zod strips unknown keys by
    // default, so a plain object schema would have deleted `n` and `total_tao`
    // from every rollup that reads one.
    const row = { netuid: 7, n: 42, total_tao: 1.5 };
    assert.deepEqual(
      await r2SqlQuery(
        mockEnv(TOKEN),
        "SELECT netuid, COUNT(*) AS n FROM chain.account_events GROUP BY netuid",
        {
          fetch: streamOf({ success: true, result: { rows: [row] } }),
          rowSchema: AccountEventsRowSchema,
          ...noCapture,
        },
      ),
      [row],
    );
  });

  test("no schema means no validation -- the 30 unmigrated reads keep working", async () => {
    assert.deepEqual(
      await r2SqlQuery(mockEnv(TOKEN), "SELECT anything FROM chain.blocks", {
        fetch: streamOf({
          success: true,
          result: { rows: [{ block_number: "still-untyped" }] },
        }),
        ...noCapture,
      }),
      [{ block_number: "still-untyped" }],
    );
  });
});
