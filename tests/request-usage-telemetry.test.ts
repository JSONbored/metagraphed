import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { POSTHOG_TRACES_SAMPLE_RATE_ENV } from "../src/tracing.ts";
import worker, { usageRouteLabel, withUsageTelemetry } from "../workers/api.ts";
import type { Row } from "./row-type.ts";

type WTCtx = Parameters<typeof withUsageTelemetry>[2];
type WTDeps = Parameters<typeof withUsageTelemetry>[4];

const CONFIGURED_ENV = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };
const SS58 = "5F3sa2TJAWMqDhXG6jhV4N8ko9SxwGy8TpaNS1repo5EYjQX";

function label(pathname: string) {
  return usageRouteLabel(new URL(`https://api.metagraph.sh${pathname}`));
}

function req(pathname = "/api/v1/subnets", init?: RequestInit) {
  return new Request(`https://api.metagraph.sh${pathname}`, init);
}

// Collects the events a run hands to the recorder, plus the promises it hands
// to waitUntil, so a test can assert on both without touching PostHog.
function recorder({ result = true as boolean | (() => unknown) } = {}) {
  const events: Row[] = [];
  return {
    events,
    recordUsageEvent(env: unknown, event: unknown) {
      events.push({ env, event });
      return typeof result === "function" ? result() : result;
    },
  } as unknown as WTDeps & { events: Row[] };
}

function fakeCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    scheduled,
    waitUntil: (promise: Promise<unknown>) => scheduled.push(promise),
  };
}

describe("usageRouteLabel", () => {
  test("labels every GraphQL operation with the transport, not the operation name", () => {
    assert.equal(label("/api/v1/graphql"), "graphql");
  });

  test("collapses path parameters into the shared route id", () => {
    assert.equal(label("/api/v1/subnets"), "subnets");
    assert.equal(label("/api/v1/subnets/74"), "subnet-detail");
    // One label for every account, not one label per ss58 address.
    assert.equal(label(`/api/v1/accounts/${SS58}`), "account-summary");
    assert.equal(label("/api/v1/blocks/123456"), "block-detail");
  });

  test("namespaces non-default networks onto the label", () => {
    assert.equal(label("/api/v1/testnet/subnets"), "testnet:subnets");
    assert.equal(label("/api/v1/local/subnets"), "local:subnets");
    assert.equal(label("/api/v1/testnet/graphql"), "testnet:graphql");
  });

  test("leaves default-network aliases unprefixed", () => {
    assert.equal(label("/api/v1/mainnet/subnets/74"), "subnet-detail");
    assert.equal(label("/api/v1/finney/subnets"), "subnets");
  });

  test("skips MCP, which is instrumented at its own dispatch chokepoint", () => {
    assert.equal(label("/mcp"), null);
    assert.equal(label("/mcp/session"), null);
  });

  test("skips traffic that is not API usage", () => {
    assert.equal(label("/"), null);
    assert.equal(label("/favicon.ico"), null);
    assert.equal(label("/badge/subnet/74.svg"), null);
    assert.equal(label("/rpc/v1/anything"), null);
  });

  test("masks identifier-shaped segments on routes outside the contract", () => {
    assert.equal(label("/api/v1/ask"), "/api/v1/ask");
    assert.equal(
      label("/api/v1/webhooks/subscriptions/123"),
      "/api/v1/webhooks/subscriptions/:n",
    );
    assert.equal(
      label("/api/v1/internal/0xdeadbeefcafe"),
      "/api/v1/internal/:hash",
    );
    assert.equal(label(`/api/v1/internal/${SS58}`), "/api/v1/internal/:ss58");
  });
});

describe("withUsageTelemetry", () => {
  test("does no telemetry work when the deployment is unconfigured", async () => {
    const spy = recorder();
    const response = await withUsageTelemetry(
      req(),
      {} as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );

    assert.equal(await response.text(), "ok");
    assert.deepEqual(spy.events, []);
  });

  test("records exactly one event per request and returns the response untouched", async () => {
    const spy = recorder();
    const ctx = fakeCtx();
    const handled = new Response("payload", { status: 200 });

    const response = await withUsageTelemetry(
      req("/api/v1/subnets/74"),
      CONFIGURED_ENV as unknown as Env,
      ctx,
      async () => handled,
      spy,
    );

    assert.equal(response, handled);
    assert.equal(spy.events.length, 1);
    const { env, event } = spy.events[0];
    assert.equal(env, CONFIGURED_ENV);
    assert.equal(event.route, "subnet-detail");
    assert.equal(event.ok, true);
    assert.equal(typeof event.durationMs, "number");
    assert.ok(event.durationMs >= 0);
    // The event is drained through waitUntil, not awaited in the request path.
    assert.equal(ctx.scheduled.length, 1);
  });

  test("records GraphQL POSTs without reading the request body", async () => {
    const spy = recorder();
    const body = JSON.stringify({ query: "{ subnets { netuid } }" });
    const request = req("/api/v1/graphql", { method: "POST", body });

    await withUsageTelemetry(
      request,
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("{}"),
      spy,
    );

    assert.equal(spy.events[0].event.route, "graphql");
    // The handler downstream still owns an unread body.
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), body);
  });

  test("does not record a route the chokepoint skips", async () => {
    const spy = recorder();
    const response = await withUsageTelemetry(
      req("/mcp", { method: "POST" }),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );

    assert.equal(await response.text(), "ok");
    assert.deepEqual(spy.events, []);
  });

  test("treats 4xx as a served request and 5xx as a failure", async () => {
    const rejected = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("nope", { status: 404 }),
      rejected,
    );
    assert.equal(rejected.events[0].event.ok, true);

    const broken = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("boom", { status: 500 }),
      broken,
    );
    assert.equal(broken.events[0].event.ok, false);
  });

  // metagraphed#7733: threads errorResponse()'s own x-metagraph-error-code
  // header into usage telemetry -- the same established code every REST
  // route handler already sets, not a new taxonomy, and does not change the
  // ok:true-for-4xx semantics the test above locks in.
  test("threads x-metagraph-error-code into errorCode, without changing the ok/4xx semantics", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () =>
        new Response("nope", {
          status: 400,
          headers: { "x-metagraph-error-code": "invalid_query" },
        }),
      spy,
    );
    assert.equal(spy.events[0].event.ok, true);
    assert.equal(spy.events[0].event.errorCode, "invalid_query");
  });

  test("threads errorCode for a 5xx too, alongside ok:false", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () =>
        new Response("boom", {
          status: 502,
          headers: { "x-metagraph-error-code": "data_query_failed" },
        }),
      spy,
    );
    assert.equal(spy.events[0].event.ok, false);
    assert.equal(spy.events[0].event.errorCode, "data_query_failed");
  });

  test("omits errorCode entirely when the response carries no error-code header", async () => {
    const success = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok", { status: 200 }),
      success,
    );
    assert.equal("errorCode" in success.events[0].event, false);

    // A route that predates the x-metagraph-error-code convention (or a
    // plain non-JSON error) must not surface a stale/empty errorCode either.
    const uncoded = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("nope", { status: 404 }),
      uncoded,
    );
    assert.equal("errorCode" in uncoded.events[0].event, false);
  });

  // metagraphed#7734: GraphQL execution errors are a spec-mandated 200 with
  // a populated `errors` array (src/graphql.ts) -- status alone can't tell
  // that apart from a real success, so this one code is a narrow, explicit
  // exception to the status<500 rule. Every other error code (including a
  // GraphQL transport-level one like graphql_bad_method) keeps the existing
  // status-based ok, proving the exception is scoped to exactly one code.
  test("graphql_execution_error flips ok to false even at HTTP 200; no other code does", async () => {
    const executionError = recorder();
    await withUsageTelemetry(
      req("/api/v1/graphql"),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-metagraph-error-code": "graphql_execution_error" },
        }),
      executionError,
    );
    assert.equal(executionError.events[0].event.ok, false);
    assert.equal(
      executionError.events[0].event.errorCode,
      "graphql_execution_error",
    );

    const fieldError = recorder();
    await withUsageTelemetry(
      req("/api/v1/graphql"),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "x-metagraph-error-code": "graphql_field_error" },
        }),
      fieldError,
    );
    assert.equal(fieldError.events[0].event.ok, true);

    const transportError = recorder();
    await withUsageTelemetry(
      req("/api/v1/graphql"),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () =>
        new Response("nope", {
          status: 405,
          headers: { "x-metagraph-error-code": "graphql_bad_method" },
        }),
      transportError,
    );
    assert.equal(transportError.events[0].event.ok, true);
  });

  test("does not record a subscription upgrade as a request", async () => {
    const spy = recorder();
    const response = await withUsageTelemetry(
      req("/api/v1/graphql", { headers: { upgrade: "websocket" } }),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("subscribed"),
      spy,
    );

    assert.equal(await response.text(), "subscribed");
    assert.deepEqual(spy.events, []);
  });

  test("records a thrown handler as a failure and still propagates the error", async () => {
    const spy = recorder();
    await assert.rejects(
      withUsageTelemetry(
        req(),
        CONFIGURED_ENV as unknown as Env,
        fakeCtx(),
        async () => {
          throw new Error("handler exploded");
        },
        spy,
      ),
      /handler exploded/,
    );

    assert.equal(spy.events.length, 1);
    assert.equal(spy.events[0].event.ok, false);
  });

  // The regression the issue asks for: a telemetry failure must never become a
  // request failure, in any of the shapes it can fail in.
  test("serves the request when the recorder rejects", async () => {
    const spy = recorder({
      result: () => Promise.reject(new Error("posthog down")),
    });
    const response = await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  });

  test("serves the request when the recorder throws synchronously", async () => {
    const spy = recorder({
      result: () => {
        throw new Error("recorder exploded");
      },
    });
    const response = await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );

    assert.equal(await response.text(), "ok");
  });

  test("serves the request when waitUntil throws", async () => {
    const spy = recorder();
    const ctx = {
      waitUntil() {
        throw new Error("isolate already finished");
      },
    };
    const response = await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      ctx,
      async () => new Response("ok"),
      spy,
    );

    assert.equal(await response.text(), "ok");
    assert.equal(spy.events.length, 1);
  });

  test("serves the request when no usable ExecutionContext is supplied", async () => {
    for (const ctx of [{}, undefined] as WTCtx[]) {
      const spy = recorder();
      const response = await withUsageTelemetry(
        req(),
        CONFIGURED_ENV as unknown as Env,
        ctx,
        async () => new Response("ok"),
        spy,
      );

      assert.equal(await response.text(), "ok");
      assert.equal(spy.events.length, 1);
    }
  });

  // metagraphed#7768: the trace-span emission has no injectable-deps seam of
  // its own (scheduleTraceSpan calls recordTraceSpan(env, span) with no
  // third arg), so this stubs globalThis.fetch directly -- the same
  // technique src/tracing.ts's own header documents discovering the
  // flakiness risk of (a real POSTHOG_PROJECT_TOKEN + a non-zero sample rate
  // makes the trace span fire through the SAME mocked fetch a naive test
  // might also use for the usage-event assertion, hence why the rate
  // defaults to 0 everywhere else in this suite).
  describe("distributed tracing", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("emits a trace span alongside the usage event when sampled", async () => {
      const calls: Row[] = [];
      globalThis.fetch = (async (url: unknown, init: Row) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const spy = recorder();
      const ctx = fakeCtx();
      await withUsageTelemetry(
        req("/api/v1/subnets/74"),
        {
          ...CONFIGURED_ENV,
          [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1",
        } as unknown as Env,
        ctx,
        async () => new Response("ok"),
        spy,
      );
      // scheduleUsageEvent's own promise + the trace span's, both drained
      // through waitUntil.
      await Promise.all(ctx.scheduled);

      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/i/v1/traces"));
      const body = JSON.parse(calls[0].init.body);
      const span = body.resourceSpans[0].scopeSpans[0].spans[0];
      assert.equal(span.name, "subnet-detail");
      assert.equal(span.status.code, 1); // OK
    });

    test("emits no trace span when the sample rate is 0 (the default)", async () => {
      const calls: Row[] = [];
      globalThis.fetch = (async (url: unknown, init: Row) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 200 });
      }) as typeof fetch;

      const ctx = fakeCtx();
      await withUsageTelemetry(
        req(),
        CONFIGURED_ENV as unknown as Env,
        ctx,
        async () => new Response("ok"),
        recorder(),
      );
      await Promise.all(ctx.scheduled);

      assert.equal(calls.length, 0);
    });

    // scheduleTraceSpan's own `if (typeof ctx?.waitUntil === "function")`
    // guard covers the case where sampling fires but this Worker's own
    // ExecutionContext isn't usable (matches the equivalent guard the usage
    // event scheduler already has, and the equivalent
    // "no usable ExecutionContext" test above for that scheduler) -- the
    // span is still fired-and-forgotten via recordTraceSpan itself, just
    // never registered with waitUntil, so the response must still serve
    // cleanly regardless.
    test("still returns the response cleanly when sampled but no usable ExecutionContext is supplied", async () => {
      globalThis.fetch = (async () =>
        new Response(null, { status: 200 })) as typeof fetch;

      const response = await withUsageTelemetry(
        req(),
        {
          ...CONFIGURED_ENV,
          [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1",
        } as unknown as Env,
        {},
        async () => new Response("ok"),
        recorder(),
      );

      assert.equal(await response.text(), "ok");
    });

    test("a trace-span emission failure never surfaces into the response", async () => {
      globalThis.fetch = (async () => {
        throw new Error("posthog traces endpoint unreachable");
      }) as typeof fetch;

      const ctx = fakeCtx();
      const response = await withUsageTelemetry(
        req(),
        {
          ...CONFIGURED_ENV,
          [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1",
        } as unknown as Env,
        ctx,
        async () => new Response("ok"),
        recorder(),
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
      // Doesn't reject even though the underlying fetch throws.
      await Promise.all(ctx.scheduled);
    });

    // scheduleTraceSpan's own .catch(() => false) is a defensive outer layer
    // on top of recordTraceSpan's own no-throw contract (which already turns
    // every failure, including a thrown fetch, into a resolved `false` --
    // see the test above). Reaching THIS line needs recordTraceSpan itself
    // to reject, which the real function's own try/catch never does --
    // mock it directly, the same technique
    // tests/mcp-server-trace-span-args-safety.test.ts uses for the
    // equivalent line in src/mcp-server.ts's scheduleTraceSpan.
    test("survives recordTraceSpan itself rejecting, not just its own internal failures", async () => {
      vi.doMock("../src/tracing.ts", async (importOriginal) => {
        const actual =
          await importOriginal<typeof import("../src/tracing.ts")>();
        return {
          ...actual,
          recordTraceSpan: async () => {
            throw new Error("recordTraceSpan itself rejected");
          },
        };
      });
      vi.resetModules();
      try {
        const { withUsageTelemetry: withUsageTelemetryRejecting } =
          await import("../workers/api.ts");
        const ctx = fakeCtx();
        const response = await withUsageTelemetryRejecting(
          req(),
          {
            ...CONFIGURED_ENV,
            [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1",
          } as unknown as Env,
          ctx,
          async () => new Response("ok"),
          recorder(),
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "ok");
        await Promise.all(ctx.scheduled);
      } finally {
        vi.doUnmock("../src/tracing.ts");
        vi.resetModules();
      }
    });
  });
});

describe("worker entry instrumentation", () => {
  test("serves a real request unchanged on an unconfigured deployment", async () => {
    const env = createLocalArtifactEnv() as unknown as Env;
    const before = await worker.fetch(req("/api/v1/health"), env, fakeCtx());
    const status = before.status;
    const body = await before.text();

    const after = await worker.fetch(req("/api/v1/health"), env, fakeCtx());

    assert.equal(after.status, status);
    assert.equal(await after.text(), body);
  });
});
