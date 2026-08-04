// #9440: uncaught faults at a Worker's top-level `fetch` reach PostHog.
//
// #9430 closed this on workers/api.ts. The same hole was open on the other two
// Workers for the same reason: each wraps its dispatcher only to emit a TRACE
// SPAN, and tracing is off by default (src/tracing.ts defaults the rate to 0,
// and neither wrangler.data.jsonc nor wrangler.registry.jsonc sets one). So
// the unsampled path -- which is every request in production -- returned the
// dispatcher's promise unwrapped, and an uncaught fault reached Cloudflare's
// logs and nothing else.
//
// Both Workers already had a capture helper; neither was reachable from the
// entry. These tests pin the entry, not the helper, because "the label exists"
// and "a request reaches it" are different claims -- the distinction that let
// three dead route labels survive in #9430.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";
import { POSTHOG_TRACES_SAMPLE_RATE_ENV } from "../src/tracing.ts";
import type { Row } from "./row-type.ts";

const CONFIGURED = { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token" };

// Every recorder in src/usage-telemetry.ts POSTs through globalThis.fetch, so
// swapping it is how a test observes a capture without reaching PostHog.
function captureTelemetry() {
  const posted: Row[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    posted,
    exceptions: () =>
      posted.filter((p) => (p.body as Row).event === "$exception"),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

let active: ReturnType<typeof captureTelemetry> | null = null;
afterEach(() => {
  active?.restore();
  active = null;
});

describe("data-api", () => {
  // A matched write route, so dispatch reaches a handler rather than the
  // 404/method gate. The handler reads its shared-secret binding first, so a
  // throwing getter produces a genuine UNHANDLED fault -- the class this
  // capture exists for. A broken D1 would not do: those failures are caught
  // and turned into responses, which is exactly why they were never the gap.
  const request = () =>
    new Request("https://data-api.internal/api/v1/internal/neurons-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

  const explodingEnv = (over: Record<string, unknown> = {}) =>
    ({
      ...CONFIGURED,
      ...over,
      get NEURONS_SYNC_SECRET(): string {
        throw new Error("binding exploded");
      },
    }) as unknown as Env;

  test("captures an uncaught fault on the UNSAMPLED path", async () => {
    active = captureTelemetry();
    const { default: worker } = await import("../workers/data-api.ts");
    // No trace rate set: the production shape, and the path that previously
    // returned the dispatcher's promise entirely unwrapped.
    await assert.rejects(
      worker.fetch(request(), explodingEnv(), undefined as never),
      /binding exploded/,
    );

    const exceptions = active.exceptions();
    assert.equal(exceptions.length, 1);
    const props = (exceptions[0].body as Row).properties as Row;
    assert.equal(props.route, "/api/v1/internal/neurons-sync");
    assert.equal(props.error_code, "internal_error");
  });

  test("captures an uncaught fault on the SAMPLED path too", async () => {
    active = captureTelemetry();
    const { default: worker } = await import("../workers/data-api.ts");
    await assert.rejects(
      worker.fetch(
        request(),
        explodingEnv({ [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1" }),
        undefined as never,
      ),
      /binding exploded/,
    );
    assert.equal(active.exceptions().length, 1);
  });

  test("captures nothing when the deployment is unconfigured", async () => {
    active = captureTelemetry();
    const { default: worker } = await import("../workers/data-api.ts");
    const env = {
      get NEURONS_SYNC_SECRET(): string {
        throw new Error("binding exploded");
      },
    } as unknown as Env;

    await assert.rejects(
      worker.fetch(request(), env, undefined as never),
      /binding exploded/,
    );
    assert.deepEqual(active.exceptions(), []);
  });

  test("a request whose URL cannot be read still names the Worker", async () => {
    // The fallback exists so a malformed URL turns one fault into ONE capture,
    // not none: the route dimension degrades to naming the Worker rather than
    // the capture vanishing. Reproduced with a url getter that throws, which
    // is what makes both the dispatcher's own `new URL()` and the label
    // derivation fail on the same request.
    active = captureTelemetry();
    const { default: worker } = await import("../workers/data-api.ts");
    const unreadable = {
      method: "GET",
      headers: new Headers(),
      get url(): string {
        throw new Error("url exploded");
      },
    } as unknown as Request;

    await assert.rejects(
      worker.fetch(
        unreadable,
        { ...CONFIGURED } as unknown as Env,
        undefined as never,
      ),
      /url exploded/,
    );
    const exceptions = active.exceptions();
    assert.equal(exceptions.length, 1);
    assert.equal(
      ((exceptions[0].body as Row).properties as Row).route,
      "data-api",
    );
  });

  test("drains through waitUntil when a context is available", async () => {
    // An already-failing request must not also be made slower by the capture.
    active = captureTelemetry();
    const { default: worker } = await import("../workers/data-api.ts");
    const scheduled: Promise<unknown>[] = [];

    await assert.rejects(
      worker.fetch(request(), explodingEnv(), {
        waitUntil: (p: Promise<unknown>) => scheduled.push(p),
      } as never),
      /binding exploded/,
    );
    assert.equal(scheduled.length, 1);
    await Promise.all(scheduled);
    assert.equal(active.exceptions().length, 1);
  });
});

describe("registry-sync-api", () => {
  const request = () =>
    new Request(
      "https://registry-sync.internal/api/v1/internal/registry-sync",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );

  test("captures an uncaught fault on the UNSAMPLED path", async () => {
    active = captureTelemetry();
    const { default: worker } = await import("../workers/registry-sync-api.ts");
    // A env whose URL parse succeeds but whose dispatch throws: the token
    // check reads a getter that blows up.
    const env = {
      ...CONFIGURED,
      get REGISTRY_SYNC_SECRET(): string {
        throw new Error("binding exploded");
      },
    } as unknown as Env;

    await assert.rejects(worker.fetch(request(), env), /binding exploded/);

    const exceptions = active.exceptions();
    assert.equal(exceptions.length, 1);
    const props = (exceptions[0].body as Row).properties as Row;
    assert.equal(props.route, "registry-sync");
    assert.equal(props.error_code, "internal_error");
  });

  test("captures an uncaught fault on the SAMPLED path too", async () => {
    // This Worker has no ExecutionContext (CI-only write path), so both the
    // span and the capture are awaited inline -- the tradeoff already
    // accepted here for error capture.
    active = captureTelemetry();
    const { default: worker } = await import("../workers/registry-sync-api.ts");
    const env = {
      ...CONFIGURED,
      [POSTHOG_TRACES_SAMPLE_RATE_ENV]: "1",
      get REGISTRY_SYNC_SECRET(): string {
        throw new Error("binding exploded");
      },
    } as unknown as Env;

    await assert.rejects(worker.fetch(request(), env), /binding exploded/);
    assert.equal(active.exceptions().length, 1);
  });

  test("captures nothing when the deployment is unconfigured", async () => {
    active = captureTelemetry();
    const { default: worker } = await import("../workers/registry-sync-api.ts");
    const env = {
      get REGISTRY_SYNC_SECRET(): string {
        throw new Error("binding exploded");
      },
    } as unknown as Env;

    await assert.rejects(worker.fetch(request(), env), /binding exploded/);
    assert.deepEqual(active.exceptions(), []);
  });
});
