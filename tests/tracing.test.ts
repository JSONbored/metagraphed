import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_TRACES_PATH,
  POSTHOG_TRACES_SAMPLE_RATE_ENV,
  isUntracedInternalRoute,
  newSpanId,
  newTraceId,
  otlpTraceExportRequest,
  recordTraceSpan,
  shouldRecordTraceSpan,
  shouldSampleTrace,
  timedSpan,
  POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV,
  tracesSampleRate,
  type TraceSpanInput,
} from "../src/tracing.ts";
import { POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV } from "../src/usage-telemetry.ts";
import { mockEnv, type Row } from "./row-type.ts";

function fakeFetch({
  ok = true,
  throws = false,
  onCall,
}: {
  ok?: boolean;
  throws?: boolean;
  onCall?: (url: string, init: Row) => void;
} = {}) {
  return (async (url: unknown, init: Row) => {
    if (throws) throw new Error("network unreachable");
    onCall?.(String(url), init);
    return { ok } as Response;
  }) as typeof fetch;
}

describe("tracesSampleRate", () => {
  test("defaults to 0 when unset", () => {
    assert.equal(tracesSampleRate(mockEnv()), 0);
  });

  test("returns the configured rate when it's a valid 0-1 number", () => {
    assert.equal(
      tracesSampleRate(mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "0.05" })),
      0.05,
    );
  });

  test("falls back to 0 for a non-numeric value", () => {
    assert.equal(
      tracesSampleRate(mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "nope" })),
      0,
    );
  });

  test("falls back to 0 for an out-of-range value", () => {
    assert.equal(
      tracesSampleRate(mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1.5" })),
      0,
    );
    assert.equal(
      tracesSampleRate(mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "-1" })),
      0,
    );
  });

  test("null/undefined env is treated as unset", () => {
    assert.equal(tracesSampleRate(null), 0);
    assert.equal(tracesSampleRate(undefined), 0);
  });
});

describe("shouldSampleTrace", () => {
  test("never samples at the default (0) rate", () => {
    assert.equal(shouldSampleTrace(mockEnv()), false);
  });

  test("always samples at rate 1", () => {
    assert.equal(
      shouldSampleTrace(mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1" })),
      true,
    );
  });
});

describe("newTraceId / newSpanId", () => {
  test("newTraceId returns a 32-char lowercase hex string", () => {
    const id = newTraceId();
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  test("newSpanId returns a 16-char lowercase hex string", () => {
    const id = newSpanId();
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  test("two calls produce different ids", () => {
    assert.notEqual(newTraceId(), newTraceId());
    assert.notEqual(newSpanId(), newSpanId());
  });
});

function baseSpan(overrides: Partial<TraceSpanInput> = {}): TraceSpanInput {
  return {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "GET /api/v1/subnets",
    startTimeMs: 1_000,
    endTimeMs: 1_050,
    ok: true,
    serviceName: "metagraphed-api",
    ...overrides,
  };
}

describe("otlpTraceExportRequest", () => {
  test("builds the resourceSpans/scopeSpans/spans envelope with the right ids/name/kind", () => {
    const req = otlpTraceExportRequest(baseSpan()) as Row;
    const span = req.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.traceId, "a".repeat(32));
    assert.equal(span.spanId, "b".repeat(16));
    assert.equal(span.name, "GET /api/v1/subnets");
    assert.equal(span.kind, 2);
  });

  test("converts start/end ms to nanosecond decimal strings", () => {
    const req = otlpTraceExportRequest(baseSpan()) as Row;
    const span = req.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.startTimeUnixNano, "1000000000");
    assert.equal(span.endTimeUnixNano, "1050000000");
  });

  test("status code is OK (1) when ok:true, ERROR (2) when ok:false", () => {
    const ok = otlpTraceExportRequest(baseSpan({ ok: true })) as Row;
    const err = otlpTraceExportRequest(baseSpan({ ok: false })) as Row;
    assert.equal(ok.resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
    assert.equal(err.resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);
  });

  test("resource carries service.name as a stringValue attribute", () => {
    const req = otlpTraceExportRequest(baseSpan()) as Row;
    assert.deepEqual(req.resourceSpans[0].resource.attributes, [
      { key: "service.name", value: { stringValue: "metagraphed-api" } },
    ]);
  });

  test("encodes boolean, integer, float, and string attribute values distinctly", () => {
    const req = otlpTraceExportRequest(
      baseSpan({
        attributes: {
          flag: true,
          count: 3,
          ratio: 0.5,
          route: "/api/v1/subnets",
        },
      }),
    ) as Row;
    const attrs = req.resourceSpans[0].scopeSpans[0].spans[0].attributes;
    assert.deepEqual(attrs, [
      { key: "flag", value: { boolValue: true } },
      { key: "count", value: { intValue: "3" } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      { key: "route", value: { stringValue: "/api/v1/subnets" } },
    ]);
  });

  test("omits undefined attribute values and defaults to an empty array when attributes is absent", () => {
    const withUndefined = otlpTraceExportRequest(
      baseSpan({ attributes: { error_code: undefined, route: "/x" } }),
    ) as Row;
    assert.deepEqual(
      withUndefined.resourceSpans[0].scopeSpans[0].spans[0].attributes,
      [{ key: "route", value: { stringValue: "/x" } }],
    );
    const noAttrs = otlpTraceExportRequest(baseSpan()) as Row;
    assert.deepEqual(
      noAttrs.resourceSpans[0].scopeSpans[0].spans[0].attributes,
      [],
    );
  });
});

describe("recordTraceSpan", () => {
  test("no-ops (false, no fetch call) when unconfigured", async () => {
    let called = false;
    const result = await recordTraceSpan(mockEnv(), baseSpan(), {
      fetch: fakeFetch({ onCall: () => (called = true) }),
    });
    assert.equal(result, false);
    assert.equal(called, false);
  });

  test("posts the OTLP body to the traces endpoint with a bearer token, returns true on success", async () => {
    let capturedUrl = "";
    let capturedInit: Row = {};
    const result = await recordTraceSpan(
      mockEnv({ POSTHOG_PROJECT_TOKEN: "phc_test_token" }),
      baseSpan(),
      {
        fetch: fakeFetch({
          ok: true,
          onCall: (url, init) => {
            capturedUrl = url;
            capturedInit = init;
          },
        }),
      },
    );
    assert.equal(result, true);
    assert.ok(capturedUrl.endsWith(POSTHOG_TRACES_PATH));
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers.authorization, "Bearer phc_test_token");
    assert.equal(capturedInit.headers["content-type"], "application/json");
    const body = JSON.parse(capturedInit.body);
    assert.equal(
      body.resourceSpans[0].scopeSpans[0].spans[0].traceId,
      "a".repeat(32),
    );
  });

  test("returns false when the endpoint responds non-ok", async () => {
    const result = await recordTraceSpan(
      mockEnv({ POSTHOG_PROJECT_TOKEN: "phc_test_token" }),
      baseSpan(),
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(result, false);
  });

  test("never throws -- a transport failure is caught and reported as false", async () => {
    const result = await recordTraceSpan(
      mockEnv({ POSTHOG_PROJECT_TOKEN: "phc_test_token" }),
      baseSpan(),
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(result, false);
  });
});

describe("timedSpan", () => {
  test("returns ok:true with the resolved value and start/end timestamps on success", async () => {
    const result = await timedSpan(async () => "done");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value, "done");
    }
    assert.ok(result.endedAt >= result.startedAt);
  });

  test("returns ok:false with the thrown error instead of rejecting", async () => {
    const boom = new Error("boom");
    const result = await timedSpan(async () => {
      throw boom;
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, boom);
    }
    assert.ok(result.endedAt >= result.startedAt);
  });
});

// #9000: one global rate cannot fit this project's traffic shape. Tracing had
// been wired into four Workers since #7768 and emitted ZERO spans in 30 days,
// and the obvious fix — set a global rate — is wrong here:
//
//   REST  ~1.1M requests/day   -> even 1% is 330K spans/month
//   MCP   ~1.9K tool calls/day -> 100% is ~56K spans/month
//
// against a 1M/month free tier the project is already ~33x over on events
// alone. A rate useful on MCP is ruinous on REST; a rate safe on REST rounds
// to no MCP spans at all.
describe("per-surface trace sampling (#9000)", () => {
  test("the mcp surface uses its own rate", () => {
    const env = mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV]: "1" });
    assert.equal(tracesSampleRate(env, "mcp"), 1);
    // ...and REST is untouched by it — this is the whole point.
    assert.equal(tracesSampleRate(env), 0);
  });

  test("mcp falls back to the general rate when it has none of its own", () => {
    const env = mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "0.05" });
    assert.equal(tracesSampleRate(env, "mcp"), 0.05);
    assert.equal(tracesSampleRate(env), 0.05);
  });

  // Absent and invalid are different: absent falls THROUGH to the general
  // rate, invalid falls back to the default. Coercing an unset key with
  // Number() yields NaN, which is indistinguishable from a typo'd value — so
  // a typo must not silently inherit the general rate.
  test("an invalid mcp rate does not silently inherit the general rate", () => {
    const env = mockEnv({
      [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "0.5",
      [POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV]: "nope",
    });
    assert.equal(tracesSampleRate(env, "mcp"), 0.5);
  });

  test("an out-of-range mcp rate is rejected, not clamped", () => {
    for (const bad of ["1.5", "-1"]) {
      assert.equal(
        tracesSampleRate(
          mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV]: bad }),
          "mcp",
        ),
        0,
      );
    }
  });

  // The zero default is load-bearing for test determinism (see the module
  // header): no test sets either var, so nothing becomes randomly flaky.
  test("both surfaces default to 0 with nothing configured", () => {
    assert.equal(tracesSampleRate(mockEnv()), 0);
    assert.equal(tracesSampleRate(mockEnv(), "mcp"), 0);
    assert.equal(shouldSampleTrace(mockEnv(), "mcp"), false);
  });

  test("an mcp rate of 1 always samples", () => {
    const env = mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV]: "1" });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(shouldSampleTrace(env, "mcp"), true);
      assert.equal(shouldSampleTrace(env), false);
    }
  });
});

// The AI-Observability tier correction (measured 2026-08-10). Spans bill
// against a 100K/month allocation, not the 1M product-analytics one every rate
// in #9000/#9466 was sized against, and the flat Math.random() gate spent that
// budget on successes while discarding the failures worth having.
describe("isUntracedInternalRoute", () => {
  test("matches the /api/v1/internal/ prefix #9005 already excluded", () => {
    assert.equal(
      isUntracedInternalRoute("/api/v1/internal/usage-rollup"),
      true,
    );
    assert.equal(
      isUntracedInternalRoute("/api/v1/internal/chain-detail-sync"),
      true,
    );
  });

  // The prefix is anchored, not a substring search: a public route is not
  // silenced because "internal" appears somewhere in it.
  test("does not match public routes", () => {
    for (const route of [
      "/api/v1/subnets/74",
      "/api/v1/internal-notes",
      "mcp.tool/get_subnet",
      "registry-sync",
    ]) {
      assert.equal(isUntracedInternalRoute(route), false);
    }
  });
});

describe("shouldRecordTraceSpan", () => {
  // The whole point: a failure is never sampled away. Rate 0 is the default
  // AND api.ts's deployed REST setting, which used to mean a 5xx there
  // produced no span ever.
  test("keeps a failure even at rate 0", () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        shouldRecordTraceSpan(mockEnv(), {
          name: "/api/v1/subnets/74",
          ok: false,
        }),
        true,
      );
    }
  });

  test("drops a success at rate 0 and keeps one at rate 1", () => {
    const dark = mockEnv();
    const lit = mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1" });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        shouldRecordTraceSpan(dark, { name: "subnet-detail", ok: true }),
        false,
      );
      assert.equal(
        shouldRecordTraceSpan(lit, { name: "subnet-detail", ok: true }),
        true,
      );
    }
  });

  // 92% of the data-api Worker's spans were one internal cron route. The
  // exclusion beats the rate: even a fully-sampled deployment stops paying for
  // machine-to-machine plumbing it never reads a percentile for.
  test("drops a successful internal route even at rate 1", () => {
    const env = mockEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1" });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        shouldRecordTraceSpan(env, {
          name: "/api/v1/internal/usage-rollup",
          ok: true,
        }),
        false,
      );
    }
  });

  // #9005's own carve-out, ported: "a failing internal ingest must stay
  // visible". The exclusion is on the success span, never on the error.
  test("keeps a FAILING internal route despite the exclusion", () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        shouldRecordTraceSpan(mockEnv(), {
          name: "/api/v1/internal/usage-rollup",
          ok: false,
        }),
        true,
      );
    }
  });

  // The per-surface split survives: "mcp" still consults its own rate first,
  // so cutting REST to 0.002 doesn't silently cut the priority surface too.
  test("a success honours the mcp surface rate, not the general one", () => {
    const env = mockEnv({
      [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "0",
      [POSTHOG_TRACES_SAMPLE_RATE_MCP_ENV]: "1",
    });
    for (let i = 0; i < 20; i += 1) {
      assert.equal(
        shouldRecordTraceSpan(env, {
          name: "mcp.tool/get_subnet",
          ok: true,
          surface: "mcp",
        }),
        true,
      );
      assert.equal(
        shouldRecordTraceSpan(env, { name: "subnet-detail", ok: true }),
        false,
      );
    }
  });
});

describe("recordTraceSpan storm guard", () => {
  const CONFIGURED = {
    POSTHOG_PROJECT_TOKEN: "phc_test",
  };

  function failedSpan(name: string): TraceSpanInput {
    return {
      traceId: newTraceId(),
      spanId: newSpanId(),
      name,
      startTimeMs: 1,
      endTimeMs: 2,
      ok: false,
      serviceName: "metagraphed-api",
    };
  }

  // shouldRecordTraceSpan returning true for a failure is permission to TRY,
  // not a promise to emit — an unsampled failure stream is the exact shape
  // that spent a month's event budget in two days.
  test("holds a repeated failure inside the window", async () => {
    const env = mockEnv({
      ...CONFIGURED,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    });
    let calls = 0;
    const fetchSpy = fakeFetch({
      onCall: () => {
        calls += 1;
      },
    });
    const span = failedSpan("/api/v1/storm-guard-held");
    assert.equal(await recordTraceSpan(env, span, { fetch: fetchSpy }), true);
    for (let i = 0; i < 10; i += 1) {
      assert.equal(
        await recordTraceSpan(env, span, { fetch: fetchSpy }),
        false,
      );
    }
    assert.equal(calls, 1);
  });

  // Distinct fingerprints are independent: one noisy route must never mask a
  // genuinely new failure somewhere else.
  test("a different route is never delayed by another's window", async () => {
    const env = mockEnv({
      ...CONFIGURED,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    });
    let calls = 0;
    const fetchSpy = fakeFetch({
      onCall: () => {
        calls += 1;
      },
    });
    for (const name of ["/api/v1/first-fault", "/api/v1/second-fault"]) {
      assert.equal(
        await recordTraceSpan(env, failedSpan(name), { fetch: fetchSpy }),
        true,
      );
    }
    assert.equal(calls, 2);
  });

  // The gate that actually bounds a FLEET-wide storm (#9900): the local map is
  // per-isolate, and a recycled isolate always looks like a first sighting.
  test("defers to the shared cross-isolate gate", async () => {
    const env = mockEnv({
      ...CONFIGURED,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    });
    let calls = 0;
    const fetchSpy = fakeFetch({
      onCall: () => {
        calls += 1;
      },
    });
    assert.equal(
      await recordTraceSpan(env, failedSpan("/api/v1/shared-held"), {
        fetch: fetchSpy,
        admitShared: async () => null,
      }),
      false,
    );
    assert.equal(calls, 0);
  });

  // Successes are thinned by the RATE, not the storm guard — throttling them
  // too would bias the latency percentiles toward whichever route happened to
  // win a window.
  test("never throttles successes", async () => {
    const env = mockEnv({
      ...CONFIGURED,
      [POSTHOG_EXCEPTION_STORM_WINDOW_MS_ENV]: "300000",
    });
    let calls = 0;
    const fetchSpy = fakeFetch({
      onCall: () => {
        calls += 1;
      },
    });
    const span: TraceSpanInput = {
      ...failedSpan("/api/v1/happy-path"),
      ok: true,
    };
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await recordTraceSpan(env, span, { fetch: fetchSpy }), true);
    }
    assert.equal(calls, 5);
  });
});
