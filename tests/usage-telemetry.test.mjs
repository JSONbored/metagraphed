import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_TOKEN_ENV,
  USAGE_EVENT_DISTINCT_ID,
  USAGE_EVENT_NAME,
  isUsageTelemetryConfigured,
  postHogCaptureUrl,
  recordUsageEvent,
  resolvePostHogHost,
  usageEventProperties,
} from "../src/usage-telemetry.mjs";

function fakeFetch({
  onFetch,
  ok = true,
  throws = false,
  bodyCancelThrows = false,
} = {}) {
  return async (url, init) => {
    if (throws) throw new Error("network down");
    onFetch?.(url, init);
    return {
      ok,
      body: {
        cancel: async () => {
          if (bodyCancelThrows) throw new Error("cancel failed");
        },
      },
    };
  };
}

describe("isUsageTelemetryConfigured", () => {
  test("false when env is missing / token empty / whitespace", () => {
    assert.equal(isUsageTelemetryConfigured(undefined), false);
    assert.equal(isUsageTelemetryConfigured({}), false);
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "" }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: "   " }),
      false,
    );
    assert.equal(
      isUsageTelemetryConfigured({ [POSTHOG_PROJECT_TOKEN_ENV]: 123 }),
      false,
    );
  });

  test("true when a non-empty token string is set", () => {
    assert.equal(
      isUsageTelemetryConfigured({
        [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
      }),
      true,
    );
  });
});

describe("usageEventProperties", () => {
  test("returns null for missing ok or non-finite / negative duration", () => {
    assert.equal(usageEventProperties(null), null);
    assert.equal(usageEventProperties({ durationMs: 10 }), null);
    assert.equal(usageEventProperties({ ok: true }), null);
    assert.equal(
      usageEventProperties({ ok: true, durationMs: Number.NaN }),
      null,
    );
    assert.equal(usageEventProperties({ ok: true, durationMs: -1 }), null);
    assert.equal(usageEventProperties({ ok: "yes", durationMs: 10 }), null);
  });

  test("allowlists only route / mcp_tool / ok / duration_ms (+ anonymous flag)", () => {
    assert.deepEqual(
      usageEventProperties({
        route: " /api/v1/subnets ",
        mcpTool: " get_subnet ",
        ok: true,
        durationMs: 12.6,
        args: { secret: "nope" },
        wallet: "5Fake",
      }),
      {
        route: "/api/v1/subnets",
        mcp_tool: "get_subnet",
        ok: true,
        duration_ms: 13,
        $process_person_profile: false,
      },
    );
  });

  test("omits blank optional labels and truncates overlong ones", () => {
    const long = "x".repeat(300);
    assert.deepEqual(
      usageEventProperties({
        route: "   ",
        mcpTool: long,
        ok: false,
        durationMs: 0,
      }),
      {
        mcp_tool: "x".repeat(256),
        ok: false,
        duration_ms: 0,
        $process_person_profile: false,
      },
    );
  });

  test("clamps absurd durations at 24h", () => {
    assert.equal(
      usageEventProperties({ ok: true, durationMs: 999_999_999 }).duration_ms,
      86_400_000,
    );
  });
});

describe("resolvePostHogHost / postHogCaptureUrl", () => {
  test("resolvePostHogHost trims a custom host or falls back to US cloud", () => {
    assert.equal(resolvePostHogHost(undefined), "https://us.i.posthog.com");
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "  https://eu.i.posthog.com " }),
      "https://eu.i.posthog.com",
    );
    assert.equal(
      resolvePostHogHost({ [POSTHOG_HOST_ENV]: "   " }),
      "https://us.i.posthog.com",
    );
  });

  test("postHogCaptureUrl normalizes trailing slashes", () => {
    assert.equal(
      postHogCaptureUrl("https://us.i.posthog.com"),
      "https://us.i.posthog.com/i/v0/e/",
    );
    assert.equal(
      postHogCaptureUrl("https://us.i.posthog.com/"),
      "https://us.i.posthog.com/i/v0/e/",
    );
  });
});

describe("recordUsageEvent — unconfigured (safe no-op)", () => {
  test("returns false and never calls fetch", async () => {
    let calls = 0;
    const recorded = await recordUsageEvent(
      {},
      { route: "/api/v1/health", ok: true, durationMs: 5 },
      {
        fetch: fakeFetch({
          onFetch: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("never throws when env is null", async () => {
    await assert.doesNotReject(() =>
      recordUsageEvent(null, { ok: true, durationMs: 1 }),
    );
  });
});

describe("recordUsageEvent — configured", () => {
  test("POSTs an allowlisted usage_event to the PostHog capture endpoint", async () => {
    const calls = [];
    const env = {
      [POSTHOG_PROJECT_TOKEN_ENV]: " phc_token ",
      [POSTHOG_HOST_ENV]: "https://eu.i.posthog.com",
    };

    const recorded = await recordUsageEvent(
      env,
      {
        route: "/api/v1/subnets/1",
        mcpTool: "get_subnet",
        ok: true,
        durationMs: 42,
      },
      {
        fetch: fakeFetch({
          onFetch: (url, init) => calls.push({ url, init }),
        }),
      },
    );

    assert.equal(recorded, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://eu.i.posthog.com/i/v0/e/");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      api_key: "phc_token",
      event: USAGE_EVENT_NAME,
      distinct_id: USAGE_EVENT_DISTINCT_ID,
      properties: {
        route: "/api/v1/subnets/1",
        mcp_tool: "get_subnet",
        ok: true,
        duration_ms: 42,
        $process_person_profile: false,
      },
    });
  });

  test("defaults host to PostHog US cloud when POSTHOG_HOST is unset", async () => {
    const calls = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: false, durationMs: 1 },
      {
        fetch: fakeFetch({
          onFetch: (url) => calls.push(url),
        }),
      },
    );
    assert.equal(calls[0], "https://us.i.posthog.com/i/v0/e/");
  });

  test("returns false for an invalid event without fetching", async () => {
    let calls = 0;
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: -5 },
      {
        fetch: fakeFetch({
          onFetch: () => {
            calls += 1;
          },
        }),
      },
    );
    assert.equal(recorded, false);
    assert.equal(calls, 0);
  });

  test("returns false when fetch throws", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 3 },
      { fetch: fakeFetch({ throws: true }) },
    );
    assert.equal(recorded, false);
  });

  test("returns false when PostHog responds non-OK", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 3 },
      { fetch: fakeFetch({ ok: false }) },
    );
    assert.equal(recorded, false);
  });

  test("swallows body.cancel errors after a successful capture", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { mcpTool: "list_tools", ok: true, durationMs: 9 },
      { fetch: fakeFetch({ bodyCancelThrows: true }) },
    );
    assert.equal(recorded, true);
  });

  test("returns false when fetch is unavailable", async () => {
    const recorded = await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 1 },
      { fetch: null },
    );
    assert.equal(recorded, false);
  });

  test("falls back to globalThis.fetch when deps omit fetch", async () => {
    const calls = [];
    const previous = globalThis.fetch;
    globalThis.fetch = fakeFetch({
      onFetch: (url, init) => calls.push({ url, init }),
    });
    try {
      const recorded = await recordUsageEvent(
        { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
        { ok: true, durationMs: 4 },
      );
      assert.equal(recorded, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://us.i.posthog.com/i/v0/e/");
    } finally {
      globalThis.fetch = previous;
    }
  });

  test("honors an injected distinctId override", async () => {
    const calls = [];
    await recordUsageEvent(
      { [POSTHOG_PROJECT_TOKEN_ENV]: "phc_token" },
      { ok: true, durationMs: 2 },
      {
        distinctId: "test-distinct",
        fetch: fakeFetch({
          onFetch: (_url, init) => calls.push(JSON.parse(init.body)),
        }),
      },
    );
    assert.equal(calls[0].distinct_id, "test-distinct");
  });
});
