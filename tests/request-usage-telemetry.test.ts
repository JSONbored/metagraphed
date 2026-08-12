import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { POSTHOG_TRACES_SAMPLE_RATE_ENV } from "../src/tracing.ts";
import worker, {
  handleRequest,
  markRequestAuthTier,
  usageRouteLabel,
  withUsageTelemetry,
} from "../workers/api.ts";
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
  // #9430: exceptions are collected separately from usage events. Injected
  // rather than left to the real recorder because CONFIGURED_ENV carries a
  // token, so an un-stubbed capture would POST to PostHog from the suite.
  const exceptions: Row[] = [];
  return {
    events,
    exceptions,
    // `deps` captured since #10606: the caller's distinct_id rides there, not
    // on the event, so a spy that dropped the third argument could not see who
    // an event was attributed to.
    recordUsageEvent(env: unknown, event: unknown, deps: unknown) {
      events.push({ env, event, deps });
      return typeof result === "function" ? result() : result;
    },
    recordExceptionEvent(env: unknown, event: unknown) {
      exceptions.push({ env, event });
      return true;
    },
  } as unknown as WTDeps & { events: Row[]; exceptions: Row[] };
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

  // #8996: the auth surface had no usage telemetry at all, because none of it
  // lives under /api/v1/. ADR 0027 established that /mcp is a live OAuth 2.1
  // protected resource and that authentication buys throughput rather than
  // reach — and the next question that invites is "does anyone actually
  // authenticate?", which was unanswerable.
  test("labels the app-served half of the OAuth auth surface", () => {
    assert.equal(label("/authorize"), "oauth-authorize");
    assert.equal(label("/oauth/callback/github"), "oauth-callback");
  });

  // #9430: the discovery documents are NOT labelled, because this Worker never
  // serves them. workers/api.entry.ts routes everything except a bare no-token
  // /mcp through @cloudflare/workers-oauth-provider, which answers its own
  // discovery endpoints (and /oauth/token, /oauth/register) internally and only
  // then falls through to the default handler — so these paths never reach
  // withUsageTelemetry at all.
  //
  // They WERE declared here and asserted by the previous version of this very
  // test, which is how three permanently-dead labels survived: asserting
  // usageRouteLabel directly proves what the function returns, never that a
  // request reaches it. The label is only real if the request arrives.
  test("does NOT label the discovery documents the OAuth library answers", () => {
    assert.equal(label("/.well-known/oauth-protected-resource"), null);
    assert.equal(label("/.well-known/oauth-protected-resource/mcp"), null);
    assert.equal(label("/.well-known/oauth-authorization-server"), null);
  });

  // A CLOSED LIST, not a `/.well-known/` prefix. A prefix would also sweep in
  // the agent-tools and server-card documents, which are crawler traffic in the
  // thousands per day — and this project is ~30x over its PostHog free tier
  // (#9004), so "instrument the auth surface" must not quietly become
  // "instrument every crawler fetch". /health is out for the same reason: our
  // own prober hits it every minute.
  test("does NOT sweep in the crawler-facing discovery documents", () => {
    for (const p of [
      "/.well-known/mcp/server-card.json",
      "/.well-known/agent-tools/index.json",
      "/.well-known/agent-tools/openai.json",
      "/.well-known/api-catalog",
      "/health",
    ]) {
      assert.equal(label(p), null, p);
    }
  });

  test("skips traffic that is not API usage", () => {
    assert.equal(label("/"), null);
    assert.equal(label("/favicon.ico"), null);
    assert.equal(label("/badge/subnet/74.svg"), null);
    assert.equal(label("/rpc/v1/anything"), null);
  });

  // #9005: internal plumbing is not usage by any caller. The firehose ingest
  // route alone emitted 177,894 usage_events in 24 hours -- 19% of the whole
  // project's volume -- because it starts with /api/v1/ and so fell into the
  // maskUsageRouteParams fallback.
  test("skips internal machine-to-machine routes", () => {
    assert.equal(label("/api/v1/internal/chain-firehose-ingest"), null);
    assert.equal(label("/api/v1/internal/keys/usage"), null);
    assert.equal(label("/api/v1/internal/anything/at/all"), null);
  });

  // The exclusion is prefix-scoped, so a real route that merely starts with
  // the same letters must keep its label. Over-matching here would silently
  // blind a public route rather than fail loudly.
  test("does not skip public routes that merely look internal", () => {
    assert.notEqual(label("/api/v1/internals"), null);
    assert.notEqual(label("/api/v1/subnets/74/internal-notes"), null);
  });

  // #9005 retargeted the :hash and :ss58 cases off /api/v1/internal/, which is
  // now excluded outright and so can no longer demonstrate masking.
  test("masks identifier-shaped segments on routes outside the contract", () => {
    // EVERY path here is synthetic, and that is the whole point.
    //
    // This case used `/api/v1/ask` until #9092 registered it, at which point
    // the label correctly became its route id and the assertion failed. The
    // lesson was written down -- "a fixture that depends on a real path
    // STAYING unregistered rots the moment someone fixes the contract" -- and
    // then the replacement used `/api/v1/webhooks/subscriptions/123`, a real
    // path. #9967 registered it and this failed for the same right reason a
    // second time.
    //
    // So: `/api/v1/not-a-route/...` for all of them. A path that can never be
    // registered cannot rot, and masking is what is under test here, not the
    // contract's membership.
    assert.equal(label("/api/v1/not-a-route"), "/api/v1/not-a-route");
    assert.equal(label("/api/v1/not-a-route/123"), "/api/v1/not-a-route/:n");
    assert.equal(
      label("/api/v1/not-a-route/0xdeadbeefcafe"),
      "/api/v1/not-a-route/:hash",
    );
    assert.equal(
      label(`/api/v1/not-a-route/${SS58}`),
      "/api/v1/not-a-route/:ss58",
    );
  });

  test("a REGISTERED route labels as its contract id, never a masked path", () => {
    // The other half of the same behaviour, pinned so the next person does not
    // rediscover it by breaking the test above. A contract route gets its
    // stable id -- which is better than a masked path on both axes that matter
    // here: it survives a path change, and it carries no identifier at all
    // rather than a redacted one.
    assert.equal(
      label(
        "/api/v1/webhooks/subscriptions/3f2a1c6e-9b7d-4e21-8c5a-2d4f6b8e0a13",
      ),
      "webhook-subscription",
    );
    assert.equal(label("/api/v1/alerts/triggers/anything"), "alert-trigger");
  });
});

describe("withUsageTelemetry — #8963 dimensions", () => {
  // Before these, usage_event carried route + ok + duration_ms at 6M
  // events/month: no way to ask which method, whether a failure was the
  // caller's or ours, or who generated the traffic.
  test("records method, status class, and client alongside the route", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req("/api/v1/subnets", {
        method: "POST",
        headers: { "user-agent": "claude-code/2.1.220" },
      }),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok", { status: 201 }),
      spy,
    );
    const event = spy.events[0].event as Row;
    assert.equal(event.method, "POST");
    assert.equal(event.statusClass, "2xx");
    assert.equal(event.client, "claude-code");
    assert.equal(event.ok, true);
  });

  // `ok` is status < 500, so a 404 and a 200 are both "ok" — which is correct
  // (a route rejecting a bad request is not broken) but makes "are callers
  // sending us garbage" unanswerable without the class.
  test("separates a client error from a success that `ok` alone conflates", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("nope", { status: 404 }),
      spy,
    );
    const event = spy.events[0].event as Row;
    assert.equal(event.ok, true);
    assert.equal(event.statusClass, "4xx");
  });

  test("still records method and client when the handler throws", async () => {
    const spy = recorder();
    await assert.rejects(() =>
      withUsageTelemetry(
        req("/api/v1/subnets", {
          headers: { "user-agent": "mcporter/0.12.3" },
        }),
        CONFIGURED_ENV as unknown as Env,
        fakeCtx(),
        async () => {
          throw new Error("handler blew up");
        },
        spy,
      ),
    );
    const event = spy.events[0].event as Row;
    assert.equal(event.ok, false);
    assert.equal(event.method, "GET");
    assert.equal(event.client, "mcporter");
    // No response existed, so there is no class to report — omitted, not
    // guessed at.
    assert.equal(event.statusClass, undefined);
  });

  // #9004: a Cloudflare Worker subrequest sends NO User-Agent, so all of it
  // landed in the "no client" bucket — ~93% of `block-detail`, the largest
  // route in the project at 758,995 events/day. Identifying it took a live
  // `wrangler tail` because the telemetry could not answer it; one Worker was
  // 82% of that route.
  test("attributes a Cloudflare Worker subrequest via cf-worker", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req("/api/v1/blocks/8728537", {
        headers: { "cf-worker": "zeronode.workers.dev" },
      }),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );
    // Prefixed, so a subrequest origin can never be confused with a
    // UA-derived client name.
    assert.equal(
      (spy.events[0].event as Row).client,
      "worker:zeronode.workers.dev",
    );
  });

  // A real client behind a Worker proxy is more interesting than the proxy.
  test("prefers the User-Agent when both are present", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req("/api/v1/subnets", {
        headers: {
          "user-agent": "claude-code/2.1.220",
          "cf-worker": "some-proxy.workers.dev",
        },
      }),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );
    assert.equal((spy.events[0].event as Row).client, "claude-code");
  });

  test("omits the client when the request carries no User-Agent", async () => {
    const spy = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );
    assert.equal((spy.events[0].event as Row).client, undefined);
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

  // #9430: an uncaught throw used to produce that ok:false usage event and
  // NOTHING else — no stack, no PostHog Issue. This wrapper had try/finally
  // with no catch, and workers/api.entry.ts dropped Sentry's withSentry()
  // wrap (#7766) without replacing it, so the most severe class of failure
  // this Worker has was also the least diagnosable.
  test("captures an uncaught throw as an $exception with the route", async () => {
    const spy = recorder();
    const ctx = fakeCtx();
    await assert.rejects(
      withUsageTelemetry(
        req("/api/v1/subnets/74"),
        CONFIGURED_ENV as unknown as Env,
        ctx,
        async () => {
          throw new Error("handler exploded");
        },
        spy,
      ),
      /handler exploded/,
    );

    assert.equal(spy.exceptions.length, 1);
    const { env, event } = spy.exceptions[0];
    assert.equal(env, CONFIGURED_ENV);
    assert.equal((event.error as Error).message, "handler exploded");
    // The same low-cardinality label the usage event carries, so the capture
    // fingerprints as `<route>:<type>` exactly like every hand-placed REST
    // capture site already does.
    assert.equal(event.route, "subnet-detail");
    assert.equal(event.errorCode, "internal_error");
    // Drained through waitUntil alongside the usage event, never awaited on a
    // path that is already failing.
    //
    // THREE, not two, since tracing became outcome-aware: the usage event, the
    // $exception, and now a failure SPAN. This env sets no trace sample rate
    // (no test does -- see src/tracing.ts's header for why), which used to
    // mean rate 0 and therefore no span on any outcome. shouldRecordTraceSpan
    // ignores the rate for `ok: false`, so the one class of request worth a
    // trace is the one class that no longer depends on winning a dice roll.
    assert.equal(ctx.scheduled.length, 3);
  });

  test("captures nothing when the handler returns a 5xx rather than throwing", async () => {
    // A 5xx is already reported as ok:false with an error code and has no
    // stack to add; capturing it here would duplicate every handled error the
    // route layer deliberately turned into a response.
    const spy = recorder();
    await withUsageTelemetry(
      req(),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("nope", { status: 503 }),
      spy,
    );

    assert.equal(spy.events[0].event.ok, false);
    assert.deepEqual(spy.exceptions, []);
  });

  test("does not capture when the deployment is unconfigured", async () => {
    const spy = recorder();
    await assert.rejects(
      withUsageTelemetry(
        req(),
        {} as unknown as Env,
        fakeCtx(),
        async () => {
          throw new Error("handler exploded");
        },
        spy,
      ),
      /handler exploded/,
    );

    // The early return for an unconfigured deployment happens before the
    // try/catch, so the throw propagates with no telemetry of either kind.
    assert.deepEqual(spy.events, []);
    assert.deepEqual(spy.exceptions, []);
  });

  test("propagates the original throw when the exception recorder itself fails", async () => {
    const spy = recorder();
    (spy as unknown as Row).recordExceptionEvent = () => {
      throw new Error("recorder exploded");
    };

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
      // The HANDLER's error, not the recorder's — telemetry must never
      // replace the fault it is describing.
      /handler exploded/,
    );
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

// #9446: auth_tier on REST.
//
// The field has been declared on UsageEvent since #8993 and populated only on
// the MCP path, so on the surface carrying 99% of traffic the question the
// tier system exists to answer -- what share of usage is authenticated, and on
// which tier -- had no data behind it at all.
describe("withUsageTelemetry — auth_tier", () => {
  test("records the tier a gate resolved for this request", async () => {
    const spy = recorder();
    const request = req("/api/v1/subnets");
    await withUsageTelemetry(
      request,
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => {
        // What the tiered gates do inside handleRequest.
        markRequestAuthTier(request, "paid");
        return new Response("ok");
      },
      spy,
    );
    assert.equal(spy.events[0].event.authTier, "paid");
  });

  test("omits it entirely for a route with no tiered gate", async () => {
    // "anonymous" would be a claim the request never made: those routes did
    // not check a key at all. Omitted, not defaulted -- the same contract
    // every other optional dimension here follows.
    const spy = recorder();
    await withUsageTelemetry(
      req("/api/v1/subnets"),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );
    assert.equal("authTier" in spy.events[0].event, false);
  });

  test("records the anonymous tier when the gate resolved one", async () => {
    // A gate that ran and found no key is a different fact from no gate at
    // all, and both must be distinguishable in the data.
    const spy = recorder();
    const request = req("/api/v1/subnets");
    await withUsageTelemetry(
      request,
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => {
        markRequestAuthTier(request, "anonymous");
        return new Response("ok");
      },
      spy,
    );
    assert.equal(spy.events[0].event.authTier, "anonymous");
  });

  test("one request's tier is never read by another", async () => {
    const spy = recorder();
    const keyed = req("/api/v1/subnets");
    await withUsageTelemetry(
      keyed,
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => {
        markRequestAuthTier(keyed, "community");
        return new Response("ok");
      },
      spy,
    );
    // A DIFFERENT Request object, so the WeakMap has no entry for it.
    await withUsageTelemetry(
      req("/api/v1/subnets"),
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => new Response("ok"),
      spy,
    );
    assert.equal(spy.events[0].event.authTier, "community");
    assert.equal("authTier" in spy.events[1].event, false);
  });

  test("a blank or non-string tier is not recorded", async () => {
    const spy = recorder();
    const request = req("/api/v1/subnets");
    await withUsageTelemetry(
      request,
      CONFIGURED_ENV as unknown as Env,
      fakeCtx(),
      async () => {
        markRequestAuthTier(request, "");
        markRequestAuthTier(request, undefined);
        return new Response("ok");
      },
      spy,
    );
    assert.equal("authTier" in spy.events[0].event, false);
  });

  test("still recorded when the handler throws", async () => {
    // The gate runs before the fault, so the tier is known and belongs on the
    // failure event as much as on a success.
    const spy = recorder();
    const request = req("/api/v1/subnets");
    await assert.rejects(
      withUsageTelemetry(
        request,
        CONFIGURED_ENV as unknown as Env,
        fakeCtx(),
        async () => {
          markRequestAuthTier(request, "free");
          throw new Error("handler exploded");
        },
        spy,
      ),
      /handler exploded/,
    );
    assert.equal(spy.events[0].event.ok, false);
    assert.equal(spy.events[0].event.authTier, "free");
  });
});

// ── distinct_id: who a REST usage event is attributed to (#10606) ───────────
//
// Every REST usage event carried the literal `metagraphed-worker`, so
// `uniq(distinct_id)` answered 1 across 142 routes and ~99% of this project's
// traffic. It surfaced while trying to establish whether 1,044 /chain/stream
// 503s were one browser reconnect-looping or a farm — a question the data
// could not answer, and still could not once geoip resolved both the refused
// and the served requests to MaxMind's US centroid.
describe("withUsageTelemetry — distinct_id", () => {
  const SALTED_ENV = {
    ...CONFIGURED_ENV,
    USAGE_DISTINCT_ID_SALT: "test-salt-not-a-real-secret",
  };

  /**
   * Run one request and return the distinct_id it was attributed to.
   *
   * AWAITS THE SCHEDULED WORK. The id is resolved inside `waitUntil` so the
   * hash never lands in front of a response, which means the recorder has not
   * necessarily been called by the time `withUsageTelemetry` resolves. The
   * unsalted path happens to settle in one microtask; the salted one does a
   * real SubtleCrypto digest and does not. A test that asserted immediately
   * would pass on the branch that does nothing and fail on the branch under
   * test.
   */
  async function attributedTo(
    env: Row,
    request: Request,
    inHandler: () => void = () => {},
  ) {
    const spy = recorder();
    const ctx = fakeCtx();
    await withUsageTelemetry(
      request,
      env as unknown as Env,
      ctx,
      async () => {
        inHandler();
        return new Response("ok");
      },
      spy,
    );
    await Promise.all(ctx.scheduled);
    return (spy.events[0]?.deps as { distinctId?: string } | undefined)
      ?.distinctId;
  }

  function fromIp(ip: string) {
    return req("/api/v1/subnets", { headers: { "cf-connecting-ip": ip } });
  }

  test("an anonymous caller is counted under a salted hash of its address", async () => {
    const id = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    assert.match(
      String(id),
      /^ip:[0-9a-f]{16}$/,
      "an anonymous caller must be counted under the ip: namespace",
    );
  });

  test("the same address is the same caller across requests", async () => {
    // The whole point: a count is only a count if the id is stable.
    const first = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    const second = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    assert.equal(first, second);
  });

  test("two addresses are two callers", async () => {
    // Guards the guard: a hash that ignored its input would satisfy the
    // stability test above and still answer 1 to every question this exists
    // to answer.
    const first = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    const second = await attributedTo(SALTED_ENV, fromIp("198.51.100.9"));
    assert.notEqual(first, second);
  });

  test("the address never appears in the id", async () => {
    const ip = "203.0.113.7";
    const id = String(await attributedTo(SALTED_ENV, fromIp(ip)));
    assert.equal(
      id.includes(ip),
      false,
      "the raw address must never reach the event store",
    );
  });

  test("the salt is what makes the hash a pseudonym", async () => {
    // IPv4 is 2^32, so an unsalted digest is a reversible encoding of the
    // address rather than a pseudonym. If the salt stopped being mixed in,
    // two deployments with different salts would agree on the id — and this
    // is the only assertion that would notice.
    const other = await attributedTo(
      { ...CONFIGURED_ENV, USAGE_DISTINCT_ID_SALT: "a-different-salt" },
      fromIp("203.0.113.7"),
    );
    const mine = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    assert.notEqual(mine, other);
  });

  test("no salt falls back to the shared id rather than hashing without one", async () => {
    // The one outcome worse than the status quo is an UNSALTED hash, which
    // would put a recoverable address in a third party's store. Absent salt
    // is a supported state and degrades to what it did before.
    const id = await attributedTo(CONFIGURED_ENV, fromIp("203.0.113.7"));
    assert.equal(id, undefined);
  });

  test("an unresolved address is not minted into a confident id", async () => {
    // resolveClientIp collapses a missing cf-connecting-ip to one fixed
    // bucket — right for a rate limiter, wrong here: hashing it would give
    // every unresolvable caller ONE specific-looking id, which reads as "one
    // caller" exactly like the shared fallback except that it looks precise.
    const id = await attributedTo(SALTED_ENV, req("/api/v1/subnets"));
    assert.equal(id, undefined);
  });

  test("a key-authenticated caller is counted as its account", async () => {
    const request = fromIp("203.0.113.7");
    const id = await attributedTo(SALTED_ENV, request, () => {
      markRequestAuthTier(request, "paid", "acct_123");
    });
    assert.equal(id, "account:acct_123");
  });

  test("a presented identity outranks an observed address", async () => {
    // An account is what the caller PROVED; an address is what we noticed.
    // The first is the better answer whenever both exist — and it is also the
    // only one that becomes a person profile.
    const request = fromIp("203.0.113.7");
    const anonymous = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    const identified = await attributedTo(SALTED_ENV, request, () => {
      markRequestAuthTier(request, "paid", "acct_123");
    });
    assert.notEqual(identified, anonymous);
    assert.equal(identified, "account:acct_123");
  });

  test("a blank or non-string account is not recorded as one", async () => {
    const request = fromIp("203.0.113.7");
    const id = await attributedTo(SALTED_ENV, request, () => {
      markRequestAuthTier(request, "anonymous", "");
      markRequestAuthTier(request, "anonymous", undefined);
      markRequestAuthTier(request, "anonymous", 7);
    });
    assert.match(
      String(id),
      /^ip:/,
      "a gate that resolved no account must leave the caller anonymous, " +
        "never attributed to an account it did not present",
    );
  });

  test("one request's account is never read by another", async () => {
    const keyed = fromIp("203.0.113.7");
    const identified = await attributedTo(SALTED_ENV, keyed, () => {
      markRequestAuthTier(keyed, "paid", "acct_123");
    });
    // A DIFFERENT Request object from the same address, so the WeakMap has no
    // entry for it and the account must not leak across.
    const next = await attributedTo(SALTED_ENV, fromIp("203.0.113.7"));
    assert.equal(identified, "account:acct_123");
    assert.match(String(next), /^ip:/);
  });
});

// ── A refusal the response is not allowed to explain (#10606) ──────────────
//
// /api/v1/chain/stream ran at 95% 5xx for days while every refusal was an
// unsampled usage_event carrying error_code: null — so the volume was paid
// for and the diagnosis was not bought. The cap kind rides an internal header
// the edge deletes: the Worker learns which limit refused, the caller does
// not (#10744 keeps every cap's response identical so a scraper cannot learn
// whether rotating addresses would help).
describe("withUsageTelemetry — chain-firehose cap attribution", () => {
  function hubEnv(capHeader: string | null) {
    return {
      ...CONFIGURED_ENV,
      CHAIN_FIREHOSE_HUB: {
        idFromName: () => "id",
        get: () => ({
          fetch: async () =>
            new Response("too many connections", {
              status: 503,
              ...(capHeader
                ? { headers: { "x-metagraph-cap": capHeader } }
                : {}),
            }),
        }),
      },
    };
  }

  async function streamRefusal(capHeader: string | null) {
    const spy = recorder();
    const ctx = fakeCtx();
    const env = hubEnv(capHeader) as unknown as Env;
    // ONE Request object through both. The cap code is carried on a WeakMap
    // keyed by request identity (the response is deliberately not allowed to
    // carry it), so handing the wrapper a different-but-equal Request would
    // look exactly like the code never being recorded.
    const request = req("/api/v1/chain/stream");
    const response = await withUsageTelemetry(
      request,
      env,
      ctx,
      () => handleRequest(request, env, ctx as unknown as WTCtx),
      spy,
    );
    await Promise.all(ctx.scheduled);
    return { response, spy };
  }

  test("the cap kind reaches telemetry as the error code", async () => {
    const { spy } = await streamRefusal("sse-per-ip");
    assert.equal(
      spy.events.at(-1)?.event.errorCode,
      "chain_firehose_cap_sse_per_ip",
    );
  });

  test("an unattributable per-IP cap is a distinguishable code", async () => {
    // The one that matters most: "one client contained" and "every caller we
    // could not identify sharing a single 20-slot bucket" are opposite
    // diagnoses and used to be the same event.
    const { spy } = await streamRefusal("sse-per-ip:unattributed");
    assert.equal(
      spy.events.at(-1)?.event.errorCode,
      "chain_firehose_cap_sse_per_ip_unattributed",
    );
  });

  test("the caller never receives the header", async () => {
    // Guards the half a scraper would exploit. If this stops holding, the
    // response starts telling a client which limit it hit and therefore
    // whether rotating addresses would help.
    const { response } = await streamRefusal("sse-per-ip");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-metagraph-cap"), null);
    assert.equal(await response.text(), "too many connections");
  });

  test("a response with no cap header is passed through untouched", async () => {
    // The overwhelming majority of responses. Reconstructing every one of
    // them to delete a header that is not there would put a copy in front of
    // every streaming body on the route.
    const { response, spy } = await streamRefusal(null);
    assert.equal(response.status, 503);
    assert.equal("errorCode" in (spy.events.at(-1)?.event ?? {}), false);
  });
});

// ── A calling Worker is a caller (#10606) ──────────────────────────────────
//
// A Worker-to-Worker subrequest carries no `cf-connecting-ip`, so it fell
// through to the shared id — and #9004 found ONE such caller
// (`zeronode.workers.dev`) was 82% of `block-detail`, the largest route in the
// project. A caller that dominates the traffic and cannot be counted is the
// exact gap this namespace closes.
describe("withUsageTelemetry — the calling Worker", () => {
  const SALTED_ENV = {
    ...CONFIGURED_ENV,
    USAGE_DISTINCT_ID_SALT: "test-salt-not-a-real-secret",
  };

  async function idFor(headers: Record<string, string>) {
    const spy = recorder();
    const ctx = fakeCtx();
    await withUsageTelemetry(
      req("/api/v1/subnets", { headers }),
      SALTED_ENV as unknown as Env,
      ctx,
      async () => new Response("ok"),
      spy,
    );
    await Promise.all(ctx.scheduled);
    return (spy.events[0]?.deps as { distinctId?: string } | undefined)
      ?.distinctId;
  }

  test("a subrequest with no address is counted as its Worker", async () => {
    assert.equal(
      await idFor({ "cf-worker": "zeronode.workers.dev" }),
      "worker:zeronode.workers.dev",
    );
  });

  test("an address outranks the calling Worker", async () => {
    // A Worker proxying a browser forwards the end user's cf-connecting-ip,
    // and the person behind the proxy is the more interesting caller — the
    // same precedence resolveUsageClient already applies to `client`.
    const id = await idFor({
      "cf-worker": "proxy.workers.dev",
      "cf-connecting-ip": "203.0.113.7",
    });
    assert.match(String(id), /^ip:[0-9a-f]{16}$/);
  });

  test("two Workers are two callers", async () => {
    assert.notEqual(
      await idFor({ "cf-worker": "a.workers.dev" }),
      await idFor({ "cf-worker": "b.workers.dev" }),
    );
  });

  test("neither an address nor a Worker still falls back", async () => {
    assert.equal(await idFor({}), undefined);
  });

  test("a Worker is never a person", async () => {
    // It is software. High volume, tiny cardinality — exactly the shape that
    // must not mint profiles.
    const { assignUsagePersonProcessing } =
      await import("../src/usage-telemetry.ts");
    const properties: Record<string, unknown> = {};
    assignUsagePersonProcessing(properties, "worker:zeronode.workers.dev");
    assert.equal(properties.$process_person_profile, false);
  });
});
