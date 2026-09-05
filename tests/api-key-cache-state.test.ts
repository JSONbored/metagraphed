import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { validateApiKey } from "../src/api-key-validation.ts";
import { authLookupCacheWrite } from "../src/auth-lookup-cache.ts";
import { mockEnv } from "./row-type.ts";

const RAW_KEY = "mg_state_cache_synthetic_credential";
const VALID = {
  valid: true,
  keyId: "key_cache_state",
  managed: true,
  tier: "paid",
  accountId: "7",
};
const ACCEPTED = { ok: true, tier: "paid", accountId: "7" };
const POLICY = { positiveTtlSeconds: 1800, negativeTtlSeconds: 30 };

afterEach(() => vi.useRealTimers());

function harness() {
  const store = new Map<string, string>();
  const verify = vi.fn(async () => Response.json(VALID));
  const state = vi.fn(async (_request: Request) =>
    Response.json({ state: "active" }),
  );
  const kv = {
    get: vi.fn(async (key: string) => {
      const raw = store.get(key);
      return raw ? JSON.parse(raw) : null;
    }),
    put: vi.fn(
      async (
        key: string,
        value: string,
        options: { expirationTtl: number },
      ) => {
        assert.ok(options.expirationTtl >= 60);
        store.set(key, value);
      },
    ),
  };
  const env = mockEnv({
    METAGRAPH_CONTROL: kv,
    API_KEY_LOOKUP_INTERNAL_TOKEN: "synthetic-internal-token",
    DATA_API: {
      fetch: async (request: Request) => {
        assert.equal(request.method, "POST");
        assert.equal(
          request.headers.get("x-api-key-lookup-token"),
          "synthetic-internal-token",
        );
        const path = new URL(request.url).pathname;
        if (path === "/api/v1/internal/keys/state") return state(request);
        assert.equal(path, "/api/v1/internal/keys/verify");
        assert.deepEqual(await request.json(), { key: RAW_KEY });
        return verify();
      },
    },
  });
  return { env, store, kv, verify, state };
}

test("managed identity is hashed and each reuse checks its bound key and account", async () => {
  const { env, store, state, verify } = harness();
  assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
  assert.equal(verify.mock.calls.length, 1);
  assert.equal(state.mock.calls.length, 3);
  for (const [request] of state.mock.calls)
    assert.deepEqual(await request.json(), {
      keyId: VALID.keyId,
      accountId: VALID.accountId,
    });
  const [key, value] = [...store.entries()][0]!;
  assert.match(key, /^api-key-lookup:v3:[a-f0-9]{64}$/);
  assert.ok(!value.includes(RAW_KEY));
});

test.each(["revoked", "pending", "denied", "unexpected", null])(
  "a fresh %s state denies a cached grant before provider expiry",
  async (next) => {
    const { env, verify, state } = harness();
    await validateApiKey(env, RAW_KEY);
    state.mockImplementation(async () => Response.json({ state: next }));
    assert.deepEqual(await validateApiKey(env, RAW_KEY), {
      ok: false,
      code:
        next === "revoked" || next === "pending"
          ? "key_revoked"
          : "invalid_key",
    });
    assert.equal(verify.mock.calls.length, 1);
  },
);

test.each([
  "throw",
  "status",
  "json",
  "null",
  "missing-binding",
  "missing-token",
])(
  "state failure (%s) fails closed and recovers on the next request",
  async (failure) => {
    const { env, state, verify } = harness();
    await validateApiKey(env, RAW_KEY);
    const failedEnv = mockEnv({
      ...env,
      ...(failure === "missing-binding" ? { DATA_API: undefined } : {}),
      ...(failure === "missing-token"
        ? { API_KEY_LOOKUP_INTERNAL_TOKEN: undefined }
        : {}),
    });
    if (failure !== "missing-binding" && failure !== "missing-token")
      state.mockImplementationOnce(async () => {
        if (failure === "throw") throw new Error("state unavailable");
        if (failure === "null") return Response.json(null);
        return new Response("invalid", {
          status: failure === "status" ? 503 : 200,
        });
      });
    assert.deepEqual(await validateApiKey(failedEnv, RAW_KEY), {
      ok: false,
      code: "invalid_key",
    });
    assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
    assert.equal(verify.mock.calls.length, 1);
  },
);

test("unmanaged keys always use fresh verification and keep no positive cache", async () => {
  const { env, verify, kv, state } = harness();
  verify.mockImplementation(async () =>
    Response.json({ ...VALID, managed: false }),
  );
  for (let i = 0; i < 3; i++)
    assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
  assert.equal(verify.mock.calls.length, 3);
  assert.equal(state.mock.calls.length, 0);
  assert.equal(kv.put.mock.calls.length, 0);
  verify.mockImplementation(async () =>
    Response.json({ valid: false, code: "DISABLED" }),
  );
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: false,
    code: "key_revoked",
  });
  assert.equal(kv.put.mock.calls[0]![2].expirationTtl, 60);
});

test("a missing ledger row forces provider verification even with a cached managed identity", async () => {
  const { env, state, verify } = harness();
  await validateApiKey(env, RAW_KEY);
  state.mockImplementation(async () => Response.json({ state: "unmanaged" }));
  verify.mockImplementation(async () =>
    Response.json({ valid: false, code: "DISABLED" }),
  );
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: false,
    code: "key_revoked",
  });
  assert.equal(verify.mock.calls.length, 2);
});

test.each([
  { ...VALID, keyId: undefined },
  { ...VALID, keyId: "mg_raw_credential" },
  { ...VALID, managed: undefined },
  { ...VALID, managed: "true" },
  { ...VALID, valid: "true" },
])("malformed verified identity cannot authorize (%#)", async (body) => {
  const { env, verify } = harness();
  verify.mockImplementation(async () => Response.json(body));
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: false,
    code: "invalid_key",
  });
});

test.each([
  {
    found: true,
    tier: "paid",
    accountId: "7",
    managed: false,
    keyId: VALID.keyId,
  },
  { found: true, tier: "paid", accountId: "7", managed: true, keyId: null },
])(
  "malformed or unmanaged cached positives require provider verification (%#)",
  async (record) => {
    const { env, store, verify, state } = harness();
    await validateApiKey(env, RAW_KEY);
    const key = [...store.keys()][0]!;
    store.set(key, authLookupCacheWrite(record, POLICY).value);
    assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
    assert.equal(verify.mock.calls.length, 2);
    assert.equal(state.mock.calls.length, 0);
  },
);

test("legacy envelopes cannot bypass the new state contract", async () => {
  const { env, store, verify } = harness();
  await validateApiKey(env, RAW_KEY);
  const [key, value] = [...store.entries()][0]!;
  store.clear();
  store.set(key.replace(":v3:", ":v2:"), value);
  verify.mockImplementation(async () => Response.json({ valid: false }));
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: false,
    code: "invalid_key",
  });
  assert.equal(verify.mock.calls.length, 2);
});

test("provider metadata refresh preserves tier upgrades and downgrades at the positive boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  const { env, verify } = harness();
  await validateApiKey(env, RAW_KEY);
  for (const [elapsed, tier] of [
    [1800_000, "free"],
    [3600_000, "paid"],
  ] as const) {
    vi.setSystemTime(now + elapsed);
    verify.mockImplementation(async () => Response.json({ ...VALID, tier }));
    assert.deepEqual(await validateApiKey(env, RAW_KEY), {
      ok: true,
      tier,
      accountId: "7",
    });
  }
  assert.equal(verify.mock.calls.length, 3);
});

test("a late positive cache write cannot authorize the next request after state changes", async () => {
  const { env, kv, state, verify } = harness();
  const put = kv.put.getMockImplementation()!;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  kv.put.mockImplementationOnce(async (...args) => {
    entered();
    await barrier;
    return put(...args);
  });
  const inFlight = validateApiKey(env, RAW_KEY);
  await started;
  state.mockImplementation(async () => Response.json({ state: "pending" }));
  release();
  assert.deepEqual(
    await inFlight,
    ACCEPTED,
    "the earlier authorization check already finished",
  );
  assert.deepEqual(await validateApiKey(env, RAW_KEY), {
    ok: false,
    code: "key_revoked",
  });
  assert.equal(verify.mock.calls.length, 1);
  assert.equal(state.mock.calls.length, 1);
});

test.each(["DISABLED", "EXPIRED", "NOT_FOUND"])(
  "an unmanaged credential rechecks provider rejection %s on its next request",
  async (code) => {
    const { env, verify } = harness();
    verify.mockImplementationOnce(async () =>
      Response.json({ ...VALID, managed: false }),
    );
    assert.deepEqual(await validateApiKey(env, RAW_KEY), ACCEPTED);
    verify.mockImplementation(async () =>
      Response.json({ valid: false, code }),
    );
    assert.deepEqual(await validateApiKey(env, RAW_KEY), {
      ok: false,
      code: code === "DISABLED" ? "key_revoked" : "invalid_key",
    });
    assert.equal(verify.mock.calls.length, 2);
  },
);
