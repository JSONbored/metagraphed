// Unit tests for wallet-signature login + self-serve fullnode/freemium API
// keys (workers/data-api.mjs's handleWallet*/handleAccountKeys*/
// handleApiKeyVerify/handleAccountTierPromote functions, reworked onto Unkey
// 2026-07-19). A dedicated test file (not folded into the already
// 7500+-line tests/data-api.test.mjs), mirroring
// tests/alert-triggers-route.test.mjs's shape: its OWN postgres mock (a
// simple per-test queue), scoped only to this file (vi.mock is
// per-test-file). Unkey's own HTTP calls (src/unkey-client.mjs) are stubbed
// via global fetch, same per-test-queue shape as the postgres mock.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.mjs";
import { createSessionToken } from "../src/wallet-auth.mjs";

const mockQueue = vi.hoisted(() => ({ current: [] }));
const sqlCalls = vi.hoisted(() => []);
const failNextQuery = vi.hoisted(() => ({ error: null }));

vi.mock("postgres", () => ({
  default: () => {
    function sql(strings, ...values) {
      let text = strings[0];
      for (let i = 0; i < values.length; i += 1) text += "?" + strings[i + 1];
      sqlCalls.push({ text, values });
      if (failNextQuery.error) {
        const err = failNextQuery.error;
        failNextQuery.error = null;
        return Promise.reject(err);
      }
      return Promise.resolve(
        mockQueue.current.length ? mockQueue.current.shift() : [],
      );
    }
    sql.begin = (cb) => cb(sql);
    sql.end = () => Promise.resolve();
    sql.json = (value) => value;
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.mjs");

function createFakeKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const SESSION_SECRET = "test-wallet-session-secret";
const UNKEY_ROOT_KEY = "test-root-key-placeholder";
const UNKEY_API_ID = "api_test123";

function baseEnv(overrides = {}) {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    METAGRAPH_CONTROL: createFakeKv(),
    WALLET_SESSION_SECRET: SESSION_SECRET,
    UNKEY_ROOT_KEY,
    UNKEY_API_ID,
    ...overrides,
  };
}

function makeTestWallet(seedByte) {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i + seedByte) % 256);
  const secretKey = secretFromSeed(seed);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, ss58: encodeAccountId32(publicKey) };
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stubs global fetch to serve Unkey v2 responses by path, in call order --
// each entry is either a plain data object (200 { data: ... }) or
// { status, data } for a non-200/custom-shaped response.
function stubUnkeyFetch(responsesByCall) {
  let call = 0;
  vi.stubGlobal("fetch", async (url, opts) => {
    const entry = responsesByCall[call];
    call += 1;
    if (!entry) throw new Error(`unexpected Unkey fetch #${call}: ${url}`);
    if (entry.throws) throw new Error("network down");
    return {
      ok: (entry.status ?? 200) < 300,
      status: entry.status ?? 200,
      json: async () => ({ data: entry.data }),
      _url: String(url),
      _body: opts?.body ? JSON.parse(opts.body) : undefined,
    };
  });
}

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
  failNextQuery.error = null;
});

afterEach(() => vi.unstubAllGlobals());

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://d${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function fetchRoute(request, env) {
  return worker.fetch(request, env, {});
}

// --- POST /api/v1/auth/wallet/challenge -------------------------------------

test("challenge: rejects a missing body (no ss58 field at all)", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    env,
    {},
  );
  assert.equal(res.status, 400);
});

test("challenge: rejects a malformed ss58 address", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: "not-an-address" },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("challenge: 503 when the KV challenge store is unavailable", async () => {
  const wallet = makeTestWallet(1);
  const env = baseEnv({ METAGRAPH_CONTROL: undefined });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("challenge: 413 when content-length declares an oversized body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: { ss58: "x" },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("challenge: 400 on unparsable JSON body", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/auth/wallet/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
    env,
    {},
  );
  assert.equal(res.status, 400);
});

test("challenge: 429 when the wallet-auth rate limiter denies", async () => {
  const wallet = makeTestWallet(2);
  const env = baseEnv({
    WALLET_AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
});

test("challenge: 413 on a body that actually exceeds the byte limit (no content-length lie needed)", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: "x".repeat(5000) },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("challenge: 200 when the rate limiter is bound and allows the request", async () => {
  const wallet = makeTestWallet(9);
  const env = baseEnv({
    WALLET_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 200);
});

test("challenge: 200 with a signable message for a valid ss58", async () => {
  const wallet = makeTestWallet(3);
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.message, new RegExp(wallet.ss58));
  assert.ok(body.expires_in_seconds > 0);
});

// --- POST /api/v1/auth/wallet/verify ----------------------------------------

test("verify: 503 when WALLET_SESSION_SECRET is not provisioned", async () => {
  const wallet = makeTestWallet(4);
  const env = baseEnv({ WALLET_SESSION_SECRET: undefined });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("verify: 429 when the wallet-auth rate limiter denies", async () => {
  const wallet = makeTestWallet(41);
  const env = baseEnv({
    WALLET_AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 429);
});

test("verify: 413 on an oversized body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: "x".repeat(5000), signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("verify: 503 when the KV challenge store is unavailable (distinct from the WALLET_SESSION_SECRET 503)", async () => {
  const wallet = makeTestWallet(42);
  const env = baseEnv({ METAGRAPH_CONTROL: undefined });
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("verify: rejects a missing body (no ss58/signature fields at all)", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/auth/wallet/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
    }),
    env,
    {},
  );
  assert.equal(res.status, 401);
});

test("verify: 401 when no challenge was issued", async () => {
  const wallet = makeTestWallet(5);
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("verify: 401 on a signature from the wrong keypair", async () => {
  const wallet = makeTestWallet(6);
  const impostor = makeTestWallet(60);
  const env = baseEnv();
  const challengeRes = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const { message } = await challengeRes.json();
  const signature = bytesToHex(
    sr25519Sign(impostor.secretKey, new TextEncoder().encode(message)),
  );
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("verify: 200 issues a session + upserts the account on a valid signature", async () => {
  const wallet = makeTestWallet(7);
  const env = baseEnv();
  mockQueue.current.push([{ id: 42, ss58: wallet.ss58, tier: "free" }]);
  const challengeRes = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const { message } = await challengeRes.json();
  const signature = bytesToHex(
    sr25519Sign(wallet.secretKey, new TextEncoder().encode(message)),
  );
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.session_token);
  assert.deepEqual(body.account, { ss58: wallet.ss58, tier: "free" });
  assert.ok(sqlCalls.some((c) => /INSERT INTO rpc_accounts/.test(c.text)));
});

test("verify: 502 when the Postgres upsert fails", async () => {
  const wallet = makeTestWallet(8);
  const env = baseEnv();
  const challengeRes = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const { message } = await challengeRes.json();
  const signature = bytesToHex(
    sr25519Sign(wallet.secretKey, new TextEncoder().encode(message)),
  );
  failNextQuery.error = new Error("connection reset");
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(res.status, 502);
});

// --- /api/v1/keys ------------------------------------------------------------

async function sessionToken(accountId = 1, ss58 = "5Dummy") {
  return createSessionToken(SESSION_SECRET, { accountId, ss58 });
}

test("keys: 503 when WALLET_SESSION_SECRET is not provisioned", async () => {
  const env = baseEnv({ WALLET_SESSION_SECRET: undefined });
  const res = await fetchRoute(req("/api/v1/keys", { method: "GET" }), env);
  assert.equal(res.status, 503);
});

test("keys: 401 when the Authorization header is missing or malformed", async () => {
  const env = baseEnv();
  const noHeader = await fetchRoute(
    req("/api/v1/keys", { method: "GET" }),
    env,
  );
  assert.equal(noHeader.status, 401);
  const badScheme = await fetchRoute(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: "Basic abc" },
    }),
    env,
  );
  assert.equal(badScheme.status, 401);
});

test("keys: 401 on an expired/forged session token", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: "Bearer not-a-real-token" },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("keys list: 200 returns this account's keys, keyed by unkey key_id", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current.push([
    {
      key_id: "key_aaaa",
      tier: "free",
      created_at: 1,
      revoked_at: null,
      last_used_at: null,
    },
  ]);
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.keys.length, 1);
  assert.equal(body.keys[0].key_id, "key_aaaa");
  assert.ok(sqlCalls.some((c) => /account_id = /.test(c.text)));
});

test("keys create: 401 when the session is missing (create's own call site)", async () => {
  const env = baseEnv();
  const res = await fetchRoute(req("/api/v1/keys", { method: "POST" }), env);
  assert.equal(res.status, 401);
});

test("keys create: 503 when Unkey isn't provisioned (UNKEY_ROOT_KEY or UNKEY_API_ID missing)", async () => {
  const env = baseEnv({ UNKEY_ROOT_KEY: undefined });
  const token = await sessionToken();
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("keys create: 429 when the mint rate limiter denies", async () => {
  const env = baseEnv({
    ACCOUNT_KEYS_MINT_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const token = await sessionToken();
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 429);
});

test("keys create: 201 succeeds when the mint rate limiter is bound and allows", async () => {
  const env = baseEnv({
    ACCOUNT_KEYS_MINT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const token = await sessionToken(11, "5Minter");
  mockQueue.current.push([{ id: 11, tier: "free" }]);
  stubUnkeyFetch([
    { data: { keyId: "key_abc123", key: "mg_opaqueSecretValue" } },
  ]);
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 201);
});

test("keys create: 404 when the session's account no longer exists", async () => {
  const env = baseEnv();
  const token = await sessionToken(999, "5Gone");
  // SELECT id, tier FROM rpc_accounts -> empty (no such account)
  mockQueue.current.push([]);
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("keys create: 502 when Unkey's createKey call fails", async () => {
  const env = baseEnv();
  const token = await sessionToken(11, "5Minter");
  mockQueue.current.push([{ id: 11, tier: "free" }]);
  stubUnkeyFetch([{ status: 500 }]);
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 502);
});

test("keys create: 201 mints a key at the account's own tier, no invite code needed", async () => {
  const env = baseEnv();
  const token = await sessionToken(11, "5Minter");
  mockQueue.current.push([{ id: 11, tier: "free" }]);
  stubUnkeyFetch([
    { data: { keyId: "key_abc123", key: "mg_opaqueSecretValue" } },
  ]);
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.key, "mg_opaqueSecretValue");
  assert.equal(body.key_id, "key_abc123");
  assert.equal(body.tier, "free");
  const insertCall = sqlCalls.find((c) => /INSERT INTO api_keys/.test(c.text));
  assert.ok(insertCall);
  assert.ok(insertCall.values.includes("key_abc123")); // unkey_key_id
  assert.ok(insertCall.values.includes("5Minter")); // owner_contact = ss58
  assert.ok(insertCall.values.includes(11)); // account_id
});

test("keys create: mints at whatever tier the account is already on (e.g. a promoted account)", async () => {
  const env = baseEnv();
  const token = await sessionToken(12, "5GittensorUser");
  mockQueue.current.push([{ id: 12, tier: "gittensor-partner" }]);
  let capturedBody;
  vi.stubGlobal("fetch", async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { keyId: "key_g1", key: "mg_gkey" } }),
    };
  });
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 201);
  assert.equal((await res.json()).tier, "gittensor-partner");
  assert.deepEqual(capturedBody.meta, { tier: "gittensor-partner" });
});

test("keys revoke: 400 on a malformed key id", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  const res = await fetchRoute(
    req("/api/v1/keys/not-a-key-id", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("keys revoke: 401 when the session is missing (revoke's own call site)", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/keys/key_aaaa", { method: "DELETE" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("keys revoke: 404 when the key doesn't exist or isn't owned by this account", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  mockQueue.current.push([]); // ownership SELECT -> no row
  const res = await fetchRoute(
    req("/api/v1/keys/key_aaaa", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("keys revoke: 502 when Unkey's revoke call fails, and the local row is NOT marked revoked", async () => {
  const env = baseEnv();
  const token = await sessionToken(3, "5Owner");
  mockQueue.current.push([{ unkey_key_id: "key_bbbb" }]); // ownership check finds it
  stubUnkeyFetch([{ status: 500 }]);
  const res = await fetchRoute(
    req("/api/v1/keys/key_bbbb", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 502);
  assert.ok(
    !sqlCalls.some((c) => /UPDATE api_keys SET revoked_at/.test(c.text)),
  );
});

test("keys revoke: 200 on a key owned by this account, disables via Unkey then marks revoked_at", async () => {
  const env = baseEnv();
  const token = await sessionToken(3, "5Owner");
  mockQueue.current.push([{ unkey_key_id: "key_bbbb" }]); // ownership check
  let capturedBody;
  vi.stubGlobal("fetch", async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    assert.match(String(url), /keys\.updateKey$/);
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
  const res = await fetchRoute(
    req("/api/v1/keys/key_bbbb", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { key_id: "key_bbbb", revoked: true });
  assert.deepEqual(capturedBody, { keyId: "key_bbbb", enabled: false });
  const updateCall = sqlCalls.find((c) =>
    /UPDATE api_keys SET revoked_at/.test(c.text),
  );
  assert.ok(updateCall);
});

test("keys: 405 for an unsupported method/path combination", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 405);
});

// --- POST /api/v1/internal/keys/verify --------------------------------------

const LOOKUP_TOKEN = "test-api-key-lookup-token";

test("internal key verify: 503 when not provisioned", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      body: { key: "mg_x" },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("internal key verify: 401 when the token is missing or wrong", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const missing = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      body: { key: "mg_x" },
    }),
    env,
  );
  assert.equal(missing.status, 401);
  const wrong = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": "wrong" },
      body: { key: "mg_x" },
    }),
    env,
  );
  assert.equal(wrong.status, 401);
});

test("internal key verify: 400 on unparsable JSON body", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    new Request("https://d/api/v1/internal/keys/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key-lookup-token": LOOKUP_TOKEN,
      },
      body: "{not json",
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("internal key verify: 400 when no key is provided", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: {},
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("internal key verify: returns Unkey's not-found result untouched", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  stubUnkeyFetch([{ data: { valid: false, code: "NOT_FOUND" } }]);
  const res = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { key: "mg_bogus" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    valid: false,
    code: "NOT_FOUND",
    tier: null,
    accountId: null,
  });
});

test("internal key verify: 200 on a valid key, and bumps last_used_at", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  let capturedBody;
  vi.stubGlobal("fetch", async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          valid: true,
          code: "VALID",
          keyId: "key_cccc",
          meta: { tier: "free" },
          identity: { externalId: "5" },
        },
      }),
    };
  });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { key: "mg_real" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    valid: true,
    code: "VALID",
    tier: "free",
    accountId: "5",
  });
  assert.equal(capturedBody.key, "mg_real");
  assert.ok(
    sqlCalls.some((c) =>
      /UPDATE api_keys SET last_used_at.*unkey_key_id/s.test(c.text),
    ),
  );
});

test("internal key verify: does not bump last_used_at for an invalid key", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  stubUnkeyFetch([{ data: { valid: false, code: "DISABLED" } }]);
  await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { key: "mg_revoked" },
    }),
    env,
  );
  assert.ok(
    !sqlCalls.some((c) => /UPDATE api_keys SET last_used_at/.test(c.text)),
  );
});

test("internal key verify: fails closed as NOT_FOUND when Unkey itself is unreachable", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  stubUnkeyFetch([{ throws: true }]);
  const res = await fetchRoute(
    req("/api/v1/internal/keys/verify", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { key: "mg_real" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { valid: false, code: "NOT_FOUND" });
});

// --- POST /api/v1/internal/accounts/tier ------------------------------------

const PROMOTE_TOKEN = "test-tier-promote-token";

test("tier promote: 503 when not provisioned", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: undefined });
  const res = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      body: { ss58: "5X", tier: "unlimited" },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("tier promote: 401 when the token is missing or wrong", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  const missing = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      body: { ss58: "5X", tier: "unlimited" },
    }),
    env,
  );
  assert.equal(missing.status, 401);
  const wrong = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": "wrong" },
      body: { ss58: "5X", tier: "unlimited" },
    }),
    env,
  );
  assert.equal(wrong.status, 401);
});

test("tier promote: 400 on unparsable JSON body", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  const res = await fetchRoute(
    new Request("https://d/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-account-tier-promote-token": PROMOTE_TOKEN,
      },
      body: "{not json",
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("tier promote: 400 when ss58 or tier is missing", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  const noTier = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5X" },
    }),
    env,
  );
  assert.equal(noTier.status, 400);
  const noSs58 = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { tier: "unlimited" },
    }),
    env,
  );
  assert.equal(noSs58.status, 400);
});

test("tier promote: 404 when no such account exists", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  mockQueue.current.push([]); // UPDATE rpc_accounts ... RETURNING -> no row
  const res = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5Gone", tier: "unlimited" },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("tier promote: 200 updates the account row and every active Unkey key in place", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  mockQueue.current.push([{ id: 9 }]); // UPDATE rpc_accounts RETURNING id
  mockQueue.current.push([
    { unkey_key_id: "key_1" },
    { unkey_key_id: "key_2" },
  ]); // active keys
  const calls = [];
  vi.stubGlobal("fetch", async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  });
  const res = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5Promote", tier: "unlimited" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    ss58: "5Promote",
    tier: "unlimited",
    keys_updated: 2,
    keys_failed: 0,
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.url.endsWith("keys.updateKey")));
  assert.deepEqual(calls[0].body, {
    keyId: "key_1",
    meta: { tier: "unlimited" },
  });
});

test("tier promote: reports keys_failed when an Unkey update call fails", async () => {
  const env = baseEnv({ ACCOUNT_TIER_PROMOTE_INTERNAL_TOKEN: PROMOTE_TOKEN });
  mockQueue.current.push([{ id: 9 }]);
  mockQueue.current.push([{ unkey_key_id: "key_1" }]);
  stubUnkeyFetch([{ status: 500 }]);
  const res = await fetchRoute(
    req("/api/v1/internal/accounts/tier", {
      method: "POST",
      headers: { "x-account-tier-promote-token": PROMOTE_TOKEN },
      body: { ss58: "5Promote", tier: "unlimited" },
    }),
    env,
  );
  const body = await res.json();
  assert.equal(body.keys_updated, 0);
  assert.equal(body.keys_failed, 1);
});

test("keys: 503 when the Hyperdrive binding is unavailable", async () => {
  const env = baseEnv({ HYPERDRIVE: undefined });
  const token = await sessionToken();
  const res = await fetchRoute(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 503);
});
