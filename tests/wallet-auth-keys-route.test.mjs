// Unit tests for wallet-signature login + account-gated fullnode API keys
// (ADR 0021, #6835, workers/data-api.mjs's handleWallet*/handleAccountKeys*
// functions). A dedicated test file (not folded into the already 7500+-line
// tests/data-api.test.mjs), mirroring tests/alert-triggers-route.test.mjs's
// shape: its OWN postgres mock (a simple per-test queue), scoped only to
// this file (vi.mock is per-test-file).
import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
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
const INVITE_CODE = "test-fullnode-invite-code";

function baseEnv(overrides = {}) {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    METAGRAPH_CONTROL: createFakeKv(),
    WALLET_SESSION_SECRET: SESSION_SECRET,
    FULLNODE_INVITE_CODE: INVITE_CODE,
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

beforeEach(() => {
  mockQueue.current = [];
  sqlCalls.length = 0;
  failNextQuery.error = null;
});

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(`https://d${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function fetch(request, env) {
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
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
  const challengeRes = await fetch(
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
  const res = await fetch(
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
  const challengeRes = await fetch(
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
  const res = await fetch(
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
  const challengeRes = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(req("/api/v1/keys", { method: "GET" }), env);
  assert.equal(res.status, 503);
});

test("keys: 401 when the Authorization header is missing or malformed", async () => {
  const env = baseEnv();
  const noHeader = await fetch(req("/api/v1/keys", { method: "GET" }), env);
  assert.equal(noHeader.status, 401);
  const badScheme = await fetch(
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
  const res = await fetch(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: "Bearer not-a-real-token" },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("keys list: 200 returns this account's keys", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current.push([
    {
      prefix: "aaaa",
      tier: "free",
      created_at: 1,
      revoked_at: null,
      last_used_at: null,
    },
  ]);
  const res = await fetch(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.keys.length, 1);
  assert.ok(sqlCalls.some((c) => /account_id = /.test(c.text)));
});

test("keys create: 401 when the session is missing (create's own call site)", async () => {
  const env = baseEnv();
  const res = await fetch(req("/api/v1/keys", { method: "POST" }), env);
  assert.equal(res.status, 401);
});

test("keys create: 503 when FULLNODE_INVITE_CODE is not provisioned", async () => {
  const env = baseEnv({ FULLNODE_INVITE_CODE: undefined });
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("keys create: 401 when the invite code is missing or wrong", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  const missing = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(missing.status, 401);
  const wrong = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": "wrong-code",
      },
    }),
    env,
  );
  assert.equal(wrong.status, 401);
});

test("keys create: 429 when the mint rate limiter denies", async () => {
  const env = baseEnv({
    ACCOUNT_KEYS_MINT_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": INVITE_CODE,
      },
    }),
    env,
  );
  assert.equal(res.status, 429);
});

test("keys create: 404 when the session's account no longer exists", async () => {
  const env = baseEnv();
  const token = await sessionToken(999, "5Gone");
  // SELECT tier FROM rpc_accounts -> empty (no such account)
  mockQueue.current.push([]);
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": INVITE_CODE,
      },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("keys create: 201 mints a key scoped to the session's account", async () => {
  const env = baseEnv();
  const token = await sessionToken(11, "5Minter");
  mockQueue.current.push([{ tier: "free" }]);
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": INVITE_CODE,
      },
    }),
    env,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.key, /^mg_[0-9a-f]{16}_[0-9a-f]{64}$/);
  assert.equal(body.prefix, body.key.split("_")[1]);
  assert.equal(body.tier, "free");
  const insertCall = sqlCalls.find((c) => /INSERT INTO api_keys/.test(c.text));
  assert.ok(insertCall);
  assert.ok(insertCall.values.includes("5Minter")); // owner_contact = ss58
  assert.ok(insertCall.values.includes(11)); // account_id
});

test("keys create: mints a 'gittensor-partner'-tier key when the Gittensor invite code is presented", async () => {
  const env = baseEnv({ FULLNODE_INVITE_CODE_GITTENSOR: "gittensor-code" });
  const token = await sessionToken(12, "5GittensorUser");
  mockQueue.current.push([{ id: 12 }]);
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": "gittensor-code",
      },
    }),
    env,
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.tier, "gittensor-partner");
  const insertCall = sqlCalls.find((c) => /INSERT INTO api_keys/.test(c.text));
  assert.ok(insertCall.values.includes("gittensor-partner"));
});

test("keys create: the private-team code and the Gittensor code are independent -- each still works when only one is configured", async () => {
  const gittensorOnlyEnv = baseEnv({
    FULLNODE_INVITE_CODE: undefined,
    FULLNODE_INVITE_CODE_GITTENSOR: "gittensor-code",
  });
  const token = await sessionToken(13, "5Solo");
  mockQueue.current.push([{ id: 13 }]);
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": "gittensor-code",
      },
    }),
    gittensorOnlyEnv,
  );
  assert.equal(res.status, 201);
  assert.equal((await res.json()).tier, "gittensor-partner");
});

test("keys create: 401 when the presented code matches neither configured cohort", async () => {
  const env = baseEnv({ FULLNODE_INVITE_CODE_GITTENSOR: "gittensor-code" });
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-fullnode-invite-code": "some-other-code",
      },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("keys revoke: 400 on a malformed prefix", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys/not-hex", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("keys revoke: 401 when the session is missing (revoke's own call site)", async () => {
  const env = baseEnv();
  const res = await fetch(
    req(`/api/v1/keys/${"a".repeat(16)}`, { method: "DELETE" }),
    env,
  );
  assert.equal(res.status, 401);
});

test("keys revoke: 404 when the key doesn't exist or isn't owned by this account", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  mockQueue.current.push([]); // UPDATE ... RETURNING -> no row
  const res = await fetch(
    req(`/api/v1/keys/${"a".repeat(16)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("keys revoke: 200 on a key owned by this account", async () => {
  const env = baseEnv();
  const token = await sessionToken(3, "5Owner");
  const prefix = "b".repeat(16);
  mockQueue.current.push([{ prefix }]);
  const res = await fetch(
    req(`/api/v1/keys/${prefix}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { prefix, revoked: true });
  const updateCall = sqlCalls.find((c) => /UPDATE api_keys/.test(c.text));
  assert.ok(updateCall.values.includes(3));
});

test("keys: 405 for an unsupported method/path combination", async () => {
  const env = baseEnv();
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys", {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 405);
});

// --- GET /api/v1/internal/keys/{prefix} -------------------------------------

const LOOKUP_TOKEN = "test-api-key-lookup-token";

test("internal key lookup: 503 when not provisioned", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined });
  const res = await fetch(
    req(`/api/v1/internal/keys/${"a".repeat(16)}`, { method: "GET" }),
    env,
  );
  assert.equal(res.status, 503);
});

test("internal key lookup: 401 when the token is missing or wrong", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const missing = await fetch(
    req(`/api/v1/internal/keys/${"a".repeat(16)}`, { method: "GET" }),
    env,
  );
  assert.equal(missing.status, 401);
  const wrong = await fetch(
    req(`/api/v1/internal/keys/${"a".repeat(16)}`, {
      method: "GET",
      headers: { "x-api-key-lookup-token": "wrong" },
    }),
    env,
  );
  assert.equal(wrong.status, 401);
});

test("internal key lookup: 400 on a trailing-slash request with no prefix segment", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetch(
    req("/api/v1/internal/keys/", {
      method: "GET",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("internal key lookup: 400 on a malformed prefix", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetch(
    req("/api/v1/internal/keys/not-hex", {
      method: "GET",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("internal key lookup: 404 when no such key exists", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  mockQueue.current.push([]); // SELECT -> no row
  const res = await fetch(
    req(`/api/v1/internal/keys/${"a".repeat(16)}`, {
      method: "GET",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
    env,
  );
  assert.equal(res.status, 404);
});

test("internal key lookup: 200 returns the stored record and bumps last_used_at", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const prefix = "c".repeat(16);
  mockQueue.current.push([
    { secret_hash: "deadbeef", tier: "free", revoked_at: null, account_id: 5 },
  ]);
  const res = await fetch(
    req(`/api/v1/internal/keys/${prefix}`, {
      method: "GET",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    secret_hash: "deadbeef",
    tier: "free",
    revoked_at: null,
    account_id: 5,
  });
  assert.ok(
    sqlCalls.some((c) => /UPDATE api_keys SET last_used_at/.test(c.text)),
  );
});

test("keys: 503 when the Hyperdrive binding is unavailable", async () => {
  const env = baseEnv({ HYPERDRIVE: undefined });
  const token = await sessionToken();
  const res = await fetch(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 503);
});
