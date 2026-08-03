// The Analytics Engine SQL client (#9228).
//
// Two things here are worth more than the plumbing coverage: the FAILURE
// posture (every fault must decline, never throw, so a caller falls back to
// the answer it already had rather than 5xx-ing) and the SAMPLING-aware
// aggregate builders. The second matters because a raw `COUNT(*)` against an
// unsampled dataset agrees exactly with the corrected `SUM(_sample_interval)`
// -- so the mistake is invisible in every test and every low-traffic
// deployment, and only starts undercounting once AE decides to sample. The
// builders exist so a call site cannot make it; these tests are what keep the
// builders honest.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import {
  analyticsSqlQuery,
  ANALYTICS_SQL_ACCOUNT_ENV,
  ANALYTICS_SQL_TOKEN_ENV,
  currentAnalyticsSqlFailureGeneration,
  isAnalyticsSqlConfigured,
  sampledAvg,
  sampledCount,
  sampledCountIf,
  sampledSum,
  weightedQuantile,
} from "../src/analytics-engine-sql.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { Row } from "./row-type.ts";

const TOKEN_ENV = { [ANALYTICS_SQL_TOKEN_ENV]: "test-token" } as unknown as Env;

/** A fetch double returning one canned response and recording the call. */
function fetchReturning(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { doFetch, calls };
}

/** Never let a test wait out the real 5s ceiling. */
const noAbort = { scheduleAbort: () => () => {} };

beforeEach(() => {
  resetModuleState();
});

describe("isAnalyticsSqlConfigured", () => {
  test("requires a non-blank token", () => {
    assert.equal(isAnalyticsSqlConfigured(null), false);
    assert.equal(isAnalyticsSqlConfigured({} as unknown as Env), false);
    assert.equal(
      isAnalyticsSqlConfigured({
        [ANALYTICS_SQL_TOKEN_ENV]: "   ",
      } as unknown as Env),
      false,
    );
    assert.equal(isAnalyticsSqlConfigured(TOKEN_ENV), true);
  });
});

describe("analyticsSqlQuery", () => {
  test("posts the query as the raw body with a bearer token", async () => {
    const { doFetch, calls } = fetchReturning(
      Response.json({ meta: [], data: [{ n: 1 }], rows: 1 }),
    );
    const rows = await analyticsSqlQuery(TOKEN_ENV, "SELECT 1 AS n", {
      fetch: doFetch,
      ...noAbort,
    });
    assert.deepEqual(rows, [{ n: 1 }]);
    assert.equal(calls.length, 1);
    // The API takes SQL as the body, not as a JSON envelope -- posting
    // {"query": ...} the way the R2 SQL client does would 400 here.
    assert.equal(calls[0]!.init.body, "SELECT 1 AS n");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(
      (calls[0]!.init.headers as Row).authorization,
      "Bearer test-token",
    );
    assert.match(
      calls[0]!.url,
      /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]+\/analytics_engine\/sql$/,
    );
  });

  test("an account override changes the URL", async () => {
    const { doFetch, calls } = fetchReturning(Response.json({ data: [] }));
    await analyticsSqlQuery(
      {
        [ANALYTICS_SQL_TOKEN_ENV]: "test-token",
        [ANALYTICS_SQL_ACCOUNT_ENV]: "abc123",
      } as unknown as Env,
      "SELECT 1",
      { fetch: doFetch, ...noAbort },
    );
    assert.match(calls[0]!.url, /\/accounts\/abc123\/analytics_engine\/sql$/);
  });

  test("an unconfigured deployment declines without a request", async () => {
    // The state this ships in. Not a fault: local/CI runs and any deployment
    // without the read token simply keep their existing fallback.
    let called = false;
    const rows = await analyticsSqlQuery(null, "SELECT 1", {
      fetch: (async () => {
        called = true;
        return Response.json({ data: [] });
      }) as unknown as typeof fetch,
      ...noAbort,
    });
    assert.equal(rows, null);
    assert.equal(called, false);
    // A decline for want of configuration is NOT a failure, so it must not
    // move the generation a caller uses to decide whether to cache.
    assert.equal(currentAnalyticsSqlFailureGeneration(), 0);
  });

  test("an empty result set is [] — a real answer, not a failure", async () => {
    const { doFetch } = fetchReturning(Response.json({ data: [], rows: 0 }));
    const rows = await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
      fetch: doFetch,
      recordException: async () => true,
      ...noAbort,
    });
    assert.deepEqual(rows, []);
    assert.equal(currentAnalyticsSqlFailureGeneration(), 0);
  });

  test("every failure declines, records, and bumps the generation", async () => {
    const failures: unknown[] = [];
    const record = (async (_env: unknown, event: Row) => {
      failures.push(event);
      return true;
    }) as never;

    // A non-2xx: the AE SQL API reports query errors as a plain-text
    // non-2xx, unlike R2 SQL's 200-with-success:false.
    const http = fetchReturning(new Response("syntax error", { status: 400 }));
    assert.equal(
      await analyticsSqlQuery(TOKEN_ENV, "SELECT bogus", {
        fetch: http.doFetch,
        recordException: record,
        ...noAbort,
      }),
      null,
    );

    // A 200 whose body is not the documented envelope. Treated as a failure,
    // NOT as an empty result: "I could not read the answer" and "no rows
    // matched" are different claims and must not collapse into one.
    const shapeless = fetchReturning(Response.json({ unexpected: true }));
    assert.equal(
      await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
        fetch: shapeless.doFetch,
        recordException: record,
        ...noAbort,
      }),
      null,
    );

    // A transport error.
    assert.equal(
      await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
        fetch: (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
        recordException: record,
        ...noAbort,
      }),
      null,
    );

    assert.equal(failures.length, 3);
    assert.equal(currentAnalyticsSqlFailureGeneration(), 3);
    for (const failure of failures) {
      assert.equal((failure as Row).route, "analytics-engine-sql");
    }
  });

  test("a hung query is aborted by the ceiling, and the timer is cancelled", async () => {
    // Injected rather than waited out -- see r2-sql.ts's own note on why a
    // real timer is not dependable in CI's shared-registry pass.
    let cancelled = false;
    const rows = await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // The injected scheduler fires before fetch is reached, so the
          // signal is ALREADY aborted by the time this runs -- an
          // addEventListener alone would never hear it and the test would
          // hang rather than fail.
          if (init.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        })) as unknown as typeof fetch,
      recordException: async () => true,
      scheduleAbort: (fire) => {
        fire();
        return () => {
          cancelled = true;
        };
      },
    });
    assert.equal(rows, null);
    assert.equal(cancelled, true, "the abort timer must always be cleared");
  });

  test("a non-Error thrown value still logs something readable", async () => {
    // `(error as Error)?.message ?? error` -- a thrown string has no
    // .message, and logging `undefined` would make the one artefact of a
    // failure useless.
    const logged: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      const rows = await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
        fetch: (async () => {
          throw "engine exploded";
        }) as unknown as typeof fetch,
        recordException: async () => true,
        ...noAbort,
      });
      assert.equal(rows, null);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(logged[0], ["[analytics-engine-sql]", "engine exploded"]);
  });

  test("falls back to the real exception recorder when no seam is injected", async () => {
    // Unconfigured telemetry makes recordExceptionEvent a no-op returning
    // false; the point is that the default is wired at all, so a production
    // failure is actually reported rather than only logged.
    const rows = await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
      fetch: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      ...noAbort,
    });
    assert.equal(rows, null);
    assert.equal(currentAnalyticsSqlFailureGeneration(), 1);
  });

  test("the failure generation resets with module state", async () => {
    await analyticsSqlQuery(TOKEN_ENV, "SELECT 1", {
      fetch: (async () => {
        throw new Error("boom");
      }) as unknown as typeof fetch,
      recordException: async () => true,
      ...noAbort,
    });
    assert.equal(currentAnalyticsSqlFailureGeneration(), 1);
    resetModuleState();
    assert.equal(currentAnalyticsSqlFailureGeneration(), 0);
  });
});

describe("sampling-aware aggregate builders", () => {
  // AE stores a subset of data points at volume and exposes the rate as
  // _sample_interval. Each of these is the corrected form of an aggregate
  // that would otherwise silently undercount.
  test("counts weight by the sample interval, never COUNT(*)", () => {
    assert.equal(sampledCount(), "SUM(_sample_interval)");
    assert.equal(
      sampledCountIf("double2 > 1"),
      "sumIf(_sample_interval, double2 > 1)",
    );
  });

  test("sums and averages weight by the sample interval", () => {
    assert.equal(sampledSum("double3"), "SUM(_sample_interval * double3)");
    assert.equal(
      sampledAvg("double3"),
      "SUM(_sample_interval * double3) / nullif(SUM(_sample_interval), 0)",
    );
  });

  test("the average is NULL over an empty window, not a divide-by-zero", () => {
    // null there means "unmeasured", which is what an empty window is.
    assert.match(sampledAvg("double3"), /nullif\(SUM\(_sample_interval\), 0\)/);
  });

  test("quantiles are weighted, so they describe events not stored rows", () => {
    assert.equal(
      weightedQuantile(0.95, "double3"),
      "quantileExactWeighted(0.95)(double3, _sample_interval)",
    );
  });

  test("an out-of-range quantile level is refused, not emitted", () => {
    // The level is a module-local literal at every call site; this guard is
    // what keeps a refactor from making it caller input.
    for (const level of [0, 1, -0.5, 1.5, Number.NaN]) {
      assert.throws(
        () => weightedQuantile(level, "double3"),
        /level must be in \(0,1\)/,
      );
    }
  });
});
