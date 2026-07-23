import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  POSTHOG_FLAGS_PATH,
  evaluateFeatureFlag,
  type EvaluateFeatureFlagDeps,
} from "../src/feature-flags.ts";
import { POSTHOG_PROJECT_TOKEN_ENV } from "../src/usage-telemetry.ts";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

interface FakeFetchOptions {
  onCall?: (call: FakeFetchCall) => void;
  ok?: boolean;
  status?: number;
  flags?: Record<string, { enabled?: boolean }>;
  throws?: boolean;
}

// A minimal fetch stand-in -- records what it was handed and lets a test
// choose the PostHog /flags-shaped response (or a transport failure).
function fakeFetch(options: FakeFetchOptions = {}): typeof fetch {
  const { onCall, ok = true, status = 200, flags, throws = false } = options;
  return (async (url: string, init: RequestInit) => {
    if (throws) throw new Error("network unreachable");
    onCall?.({ url, init, body: JSON.parse(String(init.body)) });
    return {
      ok,
      status,
      json: async () => ({ flags: flags ?? {} }),
    } as Response;
  }) as typeof fetch;
}

interface FakeKv {
  store: Map<string, string>;
  get(key: string, options?: { type: "json" }): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

function fakeKv(initial: Record<string, string> = {}): FakeKv {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, options) {
      const value = store.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

function envWith(
  kv?: FakeKv,
  extra: Record<string, unknown> = {
    [POSTHOG_PROJECT_TOKEN_ENV]: "phc_test_token",
  },
): Env {
  return {
    ...extra,
    ...(kv ? { METAGRAPH_CONTROL: kv } : {}),
  } as unknown as Env;
}

describe("evaluateFeatureFlag", () => {
  test("unconfigured (no token) with no cache returns the caller's default, never fetches", async () => {
    const kv = fakeKv();
    const calls: FakeFetchCall[] = [];
    const fetch = fakeFetch({ onCall: (c) => calls.push(c) });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      true,
      envWith(kv, {}),
      { fetch, now: () => 1000 } satisfies EvaluateFeatureFlagDeps,
    );

    assert.equal(result, true);
    assert.deepEqual(calls, []);
  });

  test("falls back to globalThis.fetch and the real Date.now when no deps are injected", async () => {
    // No `deps` argument at all -- exercises the `deps.fetch ?? globalThis.fetch`
    // and `deps.now ?? Date.now` fallbacks real callers hit (only tests pass
    // overrides). Stubs globalThis.fetch for just this call so it never makes
    // a real network request.
    const originalFetch = globalThis.fetch;
    const calls: FakeFetchCall[] = [];
    globalThis.fetch = fakeFetch({
      onCall: (c) => calls.push(c),
      flags: { "kill-switch": { enabled: true } },
    });

    try {
      const result = await evaluateFeatureFlag(
        "kill-switch",
        "metagraphed-worker",
        false,
        envWith(fakeKv()),
      );
      assert.equal(result, true);
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unconfigured with a stale cached value returns the cached value, not the default", async () => {
    const kv = fakeKv({
      "feature-flag:kill-switch": JSON.stringify({
        value: false,
        fetchedAt: 0,
      }),
    });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      true,
      envWith(kv, {}),
      { fetch: fakeFetch(), now: () => 1_000_000 },
    );

    assert.equal(result, false);
  });

  test("fresh cache hit returns the cached value without fetching", async () => {
    const kv = fakeKv({
      "feature-flag:kill-switch": JSON.stringify({
        value: true,
        fetchedAt: 1000,
      }),
    });
    const calls: FakeFetchCall[] = [];

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      false,
      envWith(kv),
      {
        fetch: fakeFetch({ onCall: (c) => calls.push(c) }),
        now: () => 1000 + 29_000,
      },
    );

    assert.equal(result, true);
    assert.deepEqual(calls, []);
  });

  test("expired cache triggers a live fetch and refreshes the cache", async () => {
    const kv = fakeKv({
      "feature-flag:kill-switch": JSON.stringify({
        value: false,
        fetchedAt: 1000,
      }),
    });
    const calls: FakeFetchCall[] = [];
    const fetch = fakeFetch({
      onCall: (c) => calls.push(c),
      flags: { "kill-switch": { enabled: true } },
    });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      false,
      envWith(kv),
      { fetch, now: () => 1000 + 30_001 },
    );

    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://us.i.posthog.com${POSTHOG_FLAGS_PATH}`);
    assert.deepEqual(calls[0].body, {
      api_key: "phc_test_token",
      distinct_id: "metagraphed-worker",
    });
    assert.deepEqual(
      JSON.parse(kv.store.get("feature-flag:kill-switch") as string),
      {
        value: true,
        fetchedAt: 1000 + 30_001,
      },
    );
  });

  test("a flag absent from a well-formed response resolves to false, not the default", async () => {
    const kv = fakeKv();
    const fetch = fakeFetch({
      flags: { "some-other-flag": { enabled: true } },
    });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      true,
      envWith(kv),
      { fetch, now: () => 1000 },
    );

    assert.equal(result, false);
  });

  test("a network failure falls back to the default when no cache exists, and logs", async () => {
    const kv = fakeKv();
    const fetch = fakeFetch({ throws: true });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      const result = await evaluateFeatureFlag(
        "kill-switch",
        "metagraphed-worker",
        true,
        envWith(kv),
        { fetch, now: () => 1000 },
      );
      assert.equal(result, true);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /evaluate\("kill-switch"\) failed/);
    } finally {
      console.error = originalError;
    }
  });

  test("a network failure with a stale cache falls back to the cached value, not the default", async () => {
    const kv = fakeKv({
      "feature-flag:kill-switch": JSON.stringify({
        value: false,
        fetchedAt: 1000,
      }),
    });
    const fetch = fakeFetch({ throws: true });
    const originalError = console.error;
    console.error = () => {};

    try {
      const result = await evaluateFeatureFlag(
        "kill-switch",
        "metagraphed-worker",
        true,
        envWith(kv),
        { fetch, now: () => 1000 + 30_001 },
      );
      assert.equal(result, false);
    } finally {
      console.error = originalError;
    }
  });

  test("a non-2xx response is treated the same as a network failure", async () => {
    const kv = fakeKv();
    const fetch = fakeFetch({ ok: false, status: 500 });
    const originalError = console.error;
    console.error = () => {};

    try {
      const result = await evaluateFeatureFlag(
        "kill-switch",
        "metagraphed-worker",
        true,
        envWith(kv),
        { fetch, now: () => 1000 },
      );
      assert.equal(result, true);
    } finally {
      console.error = originalError;
    }
  });

  test("a missing METAGRAPH_CONTROL binding degrades to a live fetch every call, never throws", async () => {
    const fetch = fakeFetch({ flags: { "kill-switch": { enabled: true } } });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      false,
      envWith(undefined),
      { fetch, now: () => 1000 },
    );

    assert.equal(result, true);
  });

  test("a KV read failure is treated as a cache miss, not a thrown error", async () => {
    const kv: FakeKv = {
      store: new Map(),
      async get(): Promise<unknown> {
        throw new Error("kv unavailable");
      },
      async put() {},
    };
    const fetch = fakeFetch({ flags: { "kill-switch": { enabled: true } } });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      false,
      envWith(kv),
      { fetch, now: () => 1000 },
    );

    assert.equal(result, true);
  });

  test("a KV write failure never prevents the already-resolved value from being returned", async () => {
    const kv = fakeKv();
    kv.put = async () => {
      throw new Error("kv unavailable");
    };
    const fetch = fakeFetch({ flags: { "kill-switch": { enabled: true } } });

    const result = await evaluateFeatureFlag(
      "kill-switch",
      "metagraphed-worker",
      false,
      envWith(kv),
      { fetch, now: () => 1000 },
    );

    assert.equal(result, true);
  });
});
