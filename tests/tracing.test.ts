import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_TRACES_PATH,
  POSTHOG_TRACES_SAMPLE_RATE_ENV,
  newSpanId,
  newTraceId,
  otlpTraceExportRequest,
  recordTraceSpan,
  shouldSampleTrace,
  timedSpan,
  tracesSampleRate,
  type TraceSpanInput,
} from "../src/tracing.ts";
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
