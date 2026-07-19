import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { validateApiKey } from "../src/api-key-validation.mjs";

const RAW_KEY = "mg_aVeryOpaqueUnkeyGeneratedSuffixHere";
const OTHER_RAW_KEY = "mg_aDifferentOpaqueUnkeyGeneratedSuffix";

function createFakeKv() {
  const store = new Map();
  return {
    async get(key, options) {
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, value);
    },
    _store: store,
  };
}

function fakeDataApi(handler) {
  return { fetch: handler };
}

describe("validateApiKey", () => {
  test("rejects a malformed key string", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await validateApiKey(env, "not-a-key");
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("rejects an empty/non-string value", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    assert.deepEqual(await validateApiKey(env, ""), {
      ok: false,
      code: "invalid_key",
    });
    assert.deepEqual(await validateApiKey(env, undefined), {
      ok: false,
      code: "invalid_key",
    });
  });

  test("strips a Bearer prefix before validating", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "free",
              accountId: "1",
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, `Bearer ${RAW_KEY}`);
    assert.deepEqual(result, { ok: true, tier: "free", accountId: "1" });
  });

  test("works end to end without any KV binding at all (no cache, still validates)", async () => {
    const env = {
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "free",
              accountId: "1",
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: true, tier: "free", accountId: "1" });
  });

  test("fails closed when DATA_API/token are unbound and KV is cold", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("returns invalid_key when Unkey reports NOT_FOUND", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(JSON.stringify({ valid: false, code: "NOT_FOUND" }), {
            status: 200,
          }),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("returns invalid_key when the upstream responds non-ok", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => new Response("{}", { status: 503 })),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("is resilient to the upstream fetch throwing (treated as not found)", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        throw new Error("network down");
      }),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("returns key_revoked when Unkey reports DISABLED", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(JSON.stringify({ valid: false, code: "DISABLED" }), {
            status: 200,
          }),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: false, code: "key_revoked" });
  });

  test("accepts a valid key (happy path), sends the bare key + token, and caches it", async () => {
    const kv = createFakeKv();
    let fetchCalls = 0;
    let capturedRequest;
    const env = {
      METAGRAPH_CONTROL: kv,
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async (request) => {
        fetchCalls += 1;
        capturedRequest = request;
        return new Response(
          JSON.stringify({
            valid: true,
            code: "VALID",
            tier: "pro",
            accountId: "7",
          }),
          { status: 200 },
        );
      }),
    };
    const result = await validateApiKey(env, RAW_KEY);

    assert.deepEqual(result, { ok: true, tier: "pro", accountId: "7" });
    assert.equal(fetchCalls, 1);
    assert.equal(capturedRequest.method, "POST");
    assert.equal(
      capturedRequest.headers.get("x-api-key-lookup-token"),
      "test-token",
    );
    assert.deepEqual(await capturedRequest.clone().json(), { key: RAW_KEY });
    assert.equal(kv._store.size, 1);
  });

  test("serves from KV cache on a repeat lookup of the same key, without calling DATA_API again", async () => {
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            valid: true,
            code: "VALID",
            tier: "free",
            accountId: "3",
          }),
          { status: 200 },
        );
      }),
    };
    await validateApiKey(env, RAW_KEY);
    const second = await validateApiKey(env, RAW_KEY);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, { ok: true, tier: "free", accountId: "3" });
  });

  test("two different keys hash to two different cache entries", async () => {
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            valid: true,
            code: "VALID",
            tier: "free",
            accountId: "3",
          }),
          { status: 200 },
        );
      }),
    };
    await validateApiKey(env, RAW_KEY);
    await validateApiKey(env, OTHER_RAW_KEY);
    assert.equal(fetchCalls, 2);
  });

  test("caches a not-found result too (negative cache)", async () => {
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({ valid: false, code: "NOT_FOUND" }),
          {
            status: 200,
          },
        );
      }),
    };
    await validateApiKey(env, RAW_KEY);
    await validateApiKey(env, RAW_KEY);
    assert.equal(fetchCalls, 1);
  });

  test("is resilient to a KV read throwing (falls through to the live lookup)", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          throw new Error("kv down");
        },
        async put() {},
      },
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "free",
              accountId: "1",
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.equal(result.ok, true);
  });

  test("is resilient to a KV write throwing (result still returned)", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get() {
          return null;
        },
        async put() {
          throw new Error("kv down");
        },
      },
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              valid: true,
              code: "VALID",
              tier: "free",
              accountId: "1",
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.equal(result.ok, true);
  });

  test("returns accountId null when the record has none", async () => {
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({ valid: true, code: "VALID", tier: "keyed" }),
            {
              status: 200,
            },
          ),
      ),
    };
    const result = await validateApiKey(env, RAW_KEY);
    assert.deepEqual(result, { ok: true, tier: "keyed", accountId: null });
  });
});
