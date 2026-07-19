import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { generateApiKey, hashApiKeySecret } from "../src/api-keys.mjs";
import { validateApiKey } from "../src/api-key-validation.mjs";

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

  test("works end to end without any KV binding at all (no cache, still validates)", async () => {
    const { full, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
    const env = {
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              secret_hash: secretHash,
              tier: "free",
              revoked_at: null,
              account_id: 1,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: true, tier: "free", accountId: 1 });
  });

  test("fails closed when DATA_API/token are unbound and KV is cold", async () => {
    const { full } = generateApiKey();
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("returns invalid_key when the upstream reports no such key (404)", async () => {
    const { full } = generateApiKey();
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => new Response("{}", { status: 404 })),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("is resilient to the upstream fetch throwing (treated as not found)", async () => {
    const { full } = generateApiKey();
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        throw new Error("network down");
      }),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("returns key_revoked for a revoked key", async () => {
    const { full, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              secret_hash: secretHash,
              tier: "free",
              revoked_at: 12345,
              account_id: 1,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: false, code: "key_revoked" });
  });

  test("returns invalid_key when the secret doesn't match the stored hash", async () => {
    const { full } = generateApiKey();
    const { secret: otherSecret } = generateApiKey();
    const wrongHash = await hashApiKeySecret(otherSecret);
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              secret_hash: wrongHash,
              tier: "free",
              revoked_at: null,
              account_id: 1,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: false, code: "invalid_key" });
  });

  test("accepts a valid, unrevoked key (happy path) and caches it in KV", async () => {
    const { full, prefix, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
    const kv = createFakeKv();
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: kv,
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async (request) => {
        fetchCalls += 1;
        assert.equal(
          request.headers.get("x-api-key-lookup-token"),
          "test-token",
        );
        assert.match(
          request.url,
          new RegExp(`/api/v1/internal/keys/${prefix}$`),
        );
        return new Response(
          JSON.stringify({
            secret_hash: secretHash,
            tier: "pro",
            revoked_at: null,
            account_id: 7,
          }),
          { status: 200 },
        );
      }),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: true, tier: "pro", accountId: 7 });
    assert.equal(fetchCalls, 1);
    assert.ok(kv._store.has(`api-key-lookup:${prefix}`));
  });

  test("serves from KV cache on a repeat lookup without calling DATA_API again", async () => {
    const { full, prefix, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        fetchCalls += 1;
        return new Response(
          JSON.stringify({
            secret_hash: secretHash,
            tier: "free",
            revoked_at: null,
            account_id: 3,
          }),
          { status: 200 },
        );
      }),
    };
    await validateApiKey(env, full);
    const second = await validateApiKey(env, full);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, { ok: true, tier: "free", accountId: 3 });
    void prefix;
  });

  test("caches a not-found result too (negative cache)", async () => {
    const { full, prefix } = generateApiKey();
    let fetchCalls = 0;
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 404 });
      }),
    };
    await validateApiKey(env, full);
    await validateApiKey(env, full);
    assert.equal(fetchCalls, 1);
    void prefix;
  });

  test("is resilient to a KV read throwing (falls through to the live lookup)", async () => {
    const { full, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
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
              secret_hash: secretHash,
              tier: "free",
              revoked_at: null,
              account_id: 1,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.equal(result.ok, true);
  });

  test("is resilient to a KV write throwing (result still returned)", async () => {
    const { full, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
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
              secret_hash: secretHash,
              tier: "free",
              revoked_at: null,
              account_id: 1,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.equal(result.ok, true);
  });

  test("returns accountId null when the record has none", async () => {
    const { full, secret } = generateApiKey();
    const secretHash = await hashApiKeySecret(secret);
    const env = {
      METAGRAPH_CONTROL: createFakeKv(),
      API_KEY_LOOKUP_INTERNAL_TOKEN: "test-token",
      DATA_API: fakeDataApi(
        async () =>
          new Response(
            JSON.stringify({
              secret_hash: secretHash,
              tier: "keyed",
              revoked_at: null,
            }),
            { status: 200 },
          ),
      ),
    };
    const result = await validateApiKey(env, full);
    assert.deepEqual(result, { ok: true, tier: "keyed", accountId: null });
  });
});
