// Unit tests for wallet-signature login + self-serve fullnode/freemium API
// keys (workers/data-api.ts's handleWallet*/handleAccountKeys*/
// handleApiKeyVerify/handleAccountTierPromote functions, reworked onto Unkey
// 2026-07-19). A dedicated test file (not folded into the already
// 7500+-line tests/data-api.test.ts), mirroring
// tests/alert-triggers-route.test.ts's shape: its OWN postgres mock (a
// simple per-test queue), scoped only to this file (vi.mock is
// per-test-file). Unkey's own HTTP calls (src/unkey-client.ts) are stubbed
// via global fetch, same per-test-queue shape as the postgres mock.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.ts";
import { createSessionToken } from "../src/wallet-auth.ts";
import type { Row } from "./row-type.ts";

const mockQueue = vi.hoisted(() => ({ current: [] as Row[][] }));
const sqlCalls = vi.hoisted(
  () => [] as Array<{ text: string; values: unknown[] }>,
);
const failNextQuery = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("postgres", () => ({
  default: () => {
    function sql(strings: TemplateStringsArray, ...values: unknown[]) {
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
    sql.begin = (cb: (sql: unknown) => unknown) => cb(sql);
    sql.end = () => Promise.resolve();
    sql.json = (value: unknown) => value;
    return sql;
  },
}));

const { default: worker } = await import("../workers/data-api.ts");

function createFakeKv() {
  const store = new Map();
  return {
    async get(key: string) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const SESSION_SECRET = "test-wallet-session-secret";
const UNKEY_ROOT_KEY = "test-root-key-placeholder";
const UNKEY_API_ID = "api_test123";

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    HYPERDRIVE: { connectionString: "postgres://mock" },
    METAGRAPH_CONTROL: createFakeKv(),
    WALLET_SESSION_SECRET: SESSION_SECRET,
    UNKEY_ROOT_KEY,
    UNKEY_API_ID,
    ...overrides,
  } as unknown as Env;
}

function makeTestWallet(seedByte: number) {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i + seedByte) % 256);
  const secretKey = secretFromSeed(seed);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, ss58: encodeAccountId32(publicKey)! };
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Stubs global fetch to serve Unkey v2 responses by path, in call order --
// each entry is either a plain data object (200 { data: ... }) or
// { status, data } for a non-200/custom-shaped response.
function stubUnkeyFetch(responsesByCall: Row[]) {
  let call = 0;
  vi.stubGlobal("fetch", async (url: unknown, opts: Row) => {
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

function req(
  path: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return new Request(`https://d${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function fetchRoute(request: Request, env: Env) {
  return worker.fetch(request, env, {} as unknown as ExecutionContext);
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
    {} as unknown as ExecutionContext,
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
    {} as unknown as ExecutionContext,
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
  const body = (await res.json()) as Row;
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
    {} as unknown as ExecutionContext,
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
  const { message } = (await challengeRes.json()) as Row;
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
  const { message } = (await challengeRes.json()) as Row;
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
  const body = (await res.json()) as Row;
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
  const { message } = (await challengeRes.json()) as Row;
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

// #8607: the id is a STRING by default, because that is what the Postgres
// driver returns for rpc_accounts.id (BIGSERIAL). This helper used to default
// to the number literal 1, which is precisely why 62 route tests passed while
// every real session was rejected in production.
async function sessionToken(accountId: number | string = "1", ss58 = "5Dummy") {
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
  const body = (await res.json()) as Row;
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
  const body = (await res.json()) as Row;
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
  let capturedBody: Row | undefined;
  vi.stubGlobal("fetch", async (_url: unknown, opts: Row) => {
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
  assert.equal(((await res.json()) as Row).tier, "gittensor-partner");
  assert.deepEqual(capturedBody!.meta, { tier: "gittensor-partner" });
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
  let capturedBody: Row | undefined;
  vi.stubGlobal("fetch", async (url: unknown, opts: Row) => {
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
  const body = (await res.json()) as Row;
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
  const body = (await res.json()) as Row;
  assert.deepEqual(body, {
    valid: false,
    code: "NOT_FOUND",
    tier: null,
    accountId: null,
  });
});

test("internal key verify: 200 on a valid key, and bumps last_used_at", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  let capturedBody: Row | undefined;
  vi.stubGlobal("fetch", async (_url: unknown, opts: Row) => {
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
  const body = (await res.json()) as Row;
  assert.deepEqual(body, {
    valid: true,
    code: "VALID",
    tier: "free",
    accountId: "5",
  });
  assert.equal(capturedBody!.key, "mg_real");
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
  const body = (await res.json()) as Row;
  assert.deepEqual(body, { valid: false, code: "NOT_FOUND" });
});

// --- POST /api/v1/internal/keys/usage (#8386) -------------------------------

test("internal key usage: 503 when not provisioned", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: undefined });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      body: { account_id: 1, route: "chain-events" },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("internal key usage: 401 when the token is missing or wrong", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      body: { account_id: 1, route: "chain-events" },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("internal key usage: 400 when account_id or route is missing", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const noRoute = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { account_id: 1 },
    }),
    env,
  );
  assert.equal(noRoute.status, 400);
  const noAccountId = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { route: "chain-events" },
    }),
    env,
  );
  assert.equal(noAccountId.status, 400);
});

test("internal key usage: 200 and upserts the daily counter", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { account_id: 7, route: "chain-events" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.ok(
    sqlCalls.some((c) => /INSERT INTO api_key_usage_daily/.test(c.text)),
  );
  assert.ok(sqlCalls.some((c) => /ON CONFLICT/.test(c.text)));
});

test("internal key usage: still returns 200 when the write itself fails (best-effort counter)", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  failNextQuery.error = new Error("db down");
  const res = await fetchRoute(
    req("/api/v1/internal/keys/usage", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: { account_id: 7, route: "chain-events" },
    }),
    env,
  );
  assert.equal(res.status, 200);
});

// --- POST /api/v1/internal/keys/quota (#8608) -------------------------------

const quotaReq = (body: unknown, token: string | null = LOOKUP_TOKEN) =>
  req("/api/v1/internal/keys/quota", {
    method: "POST",
    headers: token ? { "x-api-key-lookup-token": token } : {},
    body,
  });

test("internal quota: 503 when the shared secret is not provisioned", async () => {
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 1, limit: 10 }),
    baseEnv(),
  );
  assert.equal(res.status, 503);
});

test("internal quota: 401 on a wrong or missing token", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const body = { account_id: 7, cost: 1, limit: 10 };
  assert.equal((await fetchRoute(quotaReq(body, "wrong"), env)).status, 401);
  assert.equal((await fetchRoute(quotaReq(body, null), env)).status, 401);
});

test("internal quota: 400 on an unparseable body", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    new Request("https://api.metagraph.sh/api/v1/internal/keys/quota", {
      method: "POST",
      headers: { "x-api-key-lookup-token": LOOKUP_TOKEN },
      body: "not json",
    }),
    env,
  );
  assert.equal(res.status, 400);
});

test("internal quota: 400 on out-of-range account_id, cost or limit", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  for (const body of [
    {},
    { account_id: 0, cost: 1, limit: 10 },
    { account_id: -1, cost: 1, limit: 10 },
    { account_id: 1.5, cost: 1, limit: 10 },
    { account_id: 7, cost: -1, limit: 10 },
    // A non-numeric cost is the realistic hostile shape -- NaN/Infinity cannot
    // survive JSON.stringify, so they arrive as null and are caught by the
    // range checks instead.
    { account_id: 7, cost: "abc", limit: 10 },
    { account_id: "7; DROP TABLE", cost: 1, limit: 10 },
    { account_id: 7, cost: 1, limit: 0 },
    { account_id: 7, cost: 1, limit: null },
  ]) {
    const res = await fetchRoute(quotaReq(body), env);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test("internal quota: a spend larger than the whole day is rejected WITHOUT touching the database", async () => {
  // The SQL's conflict guard only fires on an existing row, so on the first
  // spend of a day an over-limit INSERT would otherwise be banked.
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 5000, limit: 1000 }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.allowed, false);
  assert.equal(body.used, 0);
  assert.equal(body.limit, 1000);
  assert.equal(body.remaining, 1000, "the whole day is still available");
  assert.match(String(body.resetAt), /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  assert.ok(
    !sqlCalls.some((c) => /api_quota_daily/.test(c.text)),
    "no statement was issued at all",
  );
});

test("internal quota: an allowed spend upserts atomically and reports the new balance", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  // BIGINT comes back from postgres.js as a STRING (#8607's exact trap): if it
  // reached the arithmetic uncoerced, `"100" + 25` would concatenate to
  // "10025", blow past the limit and reject a request that is well inside it.
  mockQueue.current = [[{ spent: "125", current: "125" }]];
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 25, limit: 1000 }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.allowed, true);
  assert.equal(body.used, 125, "a number, not the string postgres returned");
  assert.equal(body.remaining, 875);
  const call = sqlCalls.find((c) => /api_quota_daily/.test(c.text));
  assert.ok(call, "issued the upsert");
  // One statement, one round trip -- the guard and the balance read are a CTE,
  // not a read-then-write race.
  assert.ok(/ON CONFLICT \(account_id, day\) DO UPDATE/.test(call!.text));
  assert.ok(
    /WHERE q\.units_spent \+ EXCLUDED\.units_spent <= \?/.test(call!.text),
    "the reject-spends-nothing rule is enforced in SQL, not after the write",
  );
  assert.equal(
    sqlCalls.filter((c) => /api_quota_daily/.test(c.text)).length,
    1,
  );
});

test("internal quota: a spend the guard rejected reports the UNCHANGED balance", async () => {
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  // DO UPDATE did not fire, so `attempt` is empty and only `current` comes back.
  mockQueue.current = [[{ spent: null, current: "995" }]];
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 25, limit: 1000 }),
    env,
  );
  const body = (await res.json()) as Row;
  assert.equal(body.allowed, false);
  assert.equal(body.used, 995, "nothing was spent by the failed attempt");
  assert.equal(body.remaining, 5, "so the remainder is still spendable");
});

test("internal quota: a degenerate empty result set does not reject the caller", async () => {
  // The CTE always yields exactly one row in practice -- if no row existed the
  // INSERT cannot conflict, so `spent` is never null on a cold start. This is
  // the defensive path for a driver that hands back nothing at all (a
  // connection reset mid-statement). Treating "I don't know" as over-quota
  // would 429 a paying caller on a database hiccup, so it reads as zero spent
  // and lets the request through, matching every other fail-open branch.
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  mockQueue.current = [[]];
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 1, limit: 10 }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.allowed, true);
  assert.equal(body.used, 1);
});

test("internal quota: a database failure surfaces as 502 so the caller fails OPEN", async () => {
  // Unlike the fire-and-forget usage counter, this response is load-bearing:
  // spendDailyQuota treats any non-200 as "no verdict" and lets the request
  // through, so a swallowed 200 here would silently cap nobody.
  const env = baseEnv({ API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN });
  failNextQuery.error = new Error("db down");
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 1, limit: 10 }),
    env,
  );
  assert.equal(res.status, 502);
});

test("internal quota: 503 when hyperdrive is unbound", async () => {
  const env = baseEnv({
    API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN,
    HYPERDRIVE: undefined,
  });
  const res = await fetchRoute(
    quotaReq({ account_id: 7, cost: 1, limit: 10 }),
    env,
  );
  assert.equal(res.status, 503);
});

// --- key-level abuse controls (#8611) ---------------------------------------

const BLOCK_TOKEN = "test-block-token";
const blockEnv = (over: Record<string, unknown> = {}) =>
  baseEnv({ API_KEY_BLOCK_INTERNAL_TOKEN: BLOCK_TOKEN, ...over });
const blockReq = (
  path: string,
  body: unknown,
  token: string | null = BLOCK_TOKEN,
  method = "POST",
) =>
  req(path, {
    method,
    headers: token ? { "x-api-key-block-token": token } : {},
    ...(method === "POST" ? { body } : {}),
  });

test("block: 503 unprovisioned, 401 on a wrong or missing token", async () => {
  const body = { account_id: 7, reason_code: "abuse_manual" };
  assert.equal(
    (await fetchRoute(blockReq("/api/v1/internal/keys/block", body), baseEnv()))
      .status,
    503,
  );
  const env = blockEnv();
  assert.equal(
    (
      await fetchRoute(
        blockReq("/api/v1/internal/keys/block", body, "wrong"),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (await fetchRoute(blockReq("/api/v1/internal/keys/block", body, null), env))
      .status,
    401,
  );
});

test("unblock: 503 unprovisioned, 401 on a wrong or missing token", async () => {
  // Lifting a block is the same privilege as applying one -- an unblock route
  // that was easier to reach than the block route would be the way out.
  const body = { account_id: 7, note: "reviewed" };
  assert.equal(
    (
      await fetchRoute(
        blockReq("/api/v1/internal/keys/unblock", body),
        baseEnv(),
      )
    ).status,
    503,
  );
  const env = blockEnv();
  assert.equal(
    (
      await fetchRoute(
        blockReq("/api/v1/internal/keys/unblock", body, "wrong"),
        env,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await fetchRoute(
        blockReq("/api/v1/internal/keys/unblock", body, null),
        env,
      )
    ).status,
    401,
  );
});

test("block: does NOT share the key-verify token", async () => {
  // Cutting off a paying customer is a materially higher-privilege act than
  // recording that one made a request. If the verify token ever worked here,
  // anything holding it could block customers.
  const env = baseEnv({
    API_KEY_LOOKUP_INTERNAL_TOKEN: LOOKUP_TOKEN,
    API_KEY_BLOCK_INTERNAL_TOKEN: BLOCK_TOKEN,
  });
  const res = await fetchRoute(
    blockReq(
      "/api/v1/internal/keys/block",
      { account_id: 7, reason_code: "abuse_manual" },
      LOOKUP_TOKEN,
    ),
    env,
  );
  assert.equal(res.status, 401);
});

test("block: rejects an unknown reason code and lists the valid ones", async () => {
  const env = blockEnv();
  for (const reason of ["", "made-up", "constructor", "__proto__", 7, null]) {
    const res = await fetchRoute(
      blockReq("/api/v1/internal/keys/block", {
        account_id: 7,
        reason_code: reason,
      }),
      env,
    );
    assert.equal(res.status, 400, String(reason));
    const body = (await res.json()) as Row;
    assert.ok(Array.isArray(body.reason_codes));
  }
});

test("block: rejects a bad account_id", async () => {
  const env = blockEnv();
  for (const id of [0, -1, 1.5, "abc", null]) {
    const res = await fetchRoute(
      blockReq("/api/v1/internal/keys/block", {
        account_id: id,
        reason_code: "abuse_manual",
      }),
      env,
    );
    assert.equal(res.status, 400, String(id));
  }
});

test("block: writes the ledger row AND refreshes the edge snapshot", async () => {
  const puts: Array<{ key: string; value: string }> = [];
  const env = blockEnv({
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async (key: string, value: string) => {
        puts.push({ key, value });
      },
      delete: async () => {},
    },
  });
  mockQueue.current = [
    [{ id: "1" }],
    [{ account_id: "7", reason_code: "abuse_scraping", blocked_at: "1" }],
  ];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/block", {
      account_id: 7,
      reason_code: "abuse_scraping",
      note: "ticket 12",
      blocked_by: "ops",
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.already_blocked, false);
  assert.ok(sqlCalls.some((c) => /INSERT INTO api_key_blocks/.test(c.text)));
  // Idempotent against the one-active-block-per-account index: a retried or
  // double-clicked ops action must not 500.
  assert.ok(sqlCalls.some((c) => /ON CONFLICT DO NOTHING/.test(c.text)));
  // The snapshot is written immediately, not left to expire -- otherwise a
  // block would take up to BLOCKLIST_KV_TTL to reach the edge.
  assert.equal(puts.length, 1);
  assert.equal(puts[0].key, "api-key-blocklist");
  const snapshot = JSON.parse(puts[0].value);
  // account_id is BIGINT -> a STRING from postgres.js. The snapshot must carry
  // a NUMBER or evaluateBlock's comparison misses (the #8607 trap).
  assert.strictEqual(snapshot.blocks[0].accountId, 7);
});

test("unblock: REQUIRES a note, because an unaudited unblock is the false-positive hole", async () => {
  const env = blockEnv();
  for (const note of [undefined, "", "   "]) {
    const res = await fetchRoute(
      blockReq("/api/v1/internal/keys/unblock", { account_id: 7, note }),
      env,
    );
    assert.equal(res.status, 400, String(note));
  }
});

test("unblock: closes the row rather than deleting it, and refreshes the snapshot", async () => {
  const puts: string[] = [];
  const env = blockEnv({
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async (_k: string, v: string) => {
        puts.push(v);
      },
      delete: async () => {},
    },
  });
  mockQueue.current = [[{ id: "1" }], []];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/unblock", {
      account_id: 7,
      note: "false positive, legitimate batch job",
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Row).unblocked, true);
  const call = sqlCalls.find((c) => /UPDATE api_key_blocks/.test(c.text));
  assert.ok(call, "closes the existing row");
  assert.ok(/unblocked_at = /.test(call!.text));
  assert.ok(
    !sqlCalls.some((c) => /DELETE FROM api_key_blocks/.test(c.text)),
    "history is kept, so 'blocked in error, here is why' stays answerable",
  );
  assert.equal(puts.length, 1);
  assert.deepEqual(JSON.parse(puts[0]).blocks, []);
});

test("unblock: rejects a bad account_id before touching the database", async () => {
  const env = blockEnv();
  for (const id of [0, -1, 1.5, "abc", null]) {
    const res = await fetchRoute(
      blockReq("/api/v1/internal/keys/unblock", {
        account_id: id,
        note: "reviewed",
      }),
      env,
    );
    assert.equal(res.status, 400, String(id));
  }
  assert.ok(!sqlCalls.some((c) => /api_key_blocks/.test(c.text)));
});

test("anomalies: an already-blocked account is annotated, not re-flagged", async () => {
  const env = blockEnv();
  mockQueue.current = [
    [
      { account_id: "7", day: "2026-07-01", route: "a", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "b", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "c", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "d", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "e", request_count: "5" },
    ],
    [{ account_id: "7", reason_code: "abuse_scraping" }],
  ];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/anomalies", null, BLOCK_TOKEN, "GET"),
    env,
  );
  const flagged = ((await res.json()) as Row).flagged as Row[];
  assert.equal(flagged[0].blocked_reason_code, "abuse_scraping");
});

test("unblock: reports false when there was no active block", async () => {
  const env = blockEnv({
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  });
  mockQueue.current = [[], []];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/unblock", { account_id: 7, note: "n/a" }),
    env,
  );
  assert.equal(((await res.json()) as Row).unblocked, false);
});

test("anomalies: read-only review queue, ranked, never blocks anyone", async () => {
  const env = blockEnv();
  mockQueue.current = [
    [
      { account_id: "7", day: "2026-07-01", route: "mcp", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "ask", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "a", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "b", request_count: "5" },
      { account_id: "7", day: "2026-07-01", route: "c", request_count: "5" },
    ],
    [],
  ];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/anomalies", null, BLOCK_TOKEN, "GET"),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.flagged_count, 1);
  const flagged = (body.flagged as Row[])[0];
  assert.equal(flagged.account_id, 7);
  assert.equal(flagged.blocked_reason_code, null);
  // Advisory only: the route issues no writes at all.
  assert.ok(
    !sqlCalls.some((c) =>
      /INSERT INTO api_key_blocks|UPDATE api_key_blocks/.test(c.text),
    ),
  );
});

test("block/unblock: 400 on an unparseable body", async () => {
  const env = blockEnv();
  for (const path of [
    "/api/v1/internal/keys/block",
    "/api/v1/internal/keys/unblock",
  ]) {
    const res = await fetchRoute(
      new Request(`https://d${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key-block-token": BLOCK_TOKEN,
        },
        body: "{not json",
      }),
      env,
    );
    assert.equal(res.status, 400, path);
  }
});

test("block: a non-string note or blocked_by is dropped, not stringified", async () => {
  const env = blockEnv({
    METAGRAPH_CONTROL: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  });
  mockQueue.current = [[{ id: "1" }], []];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/block", {
      account_id: 7,
      reason_code: "abuse_manual",
      note: { evil: true },
      blocked_by: 42,
    }),
    env,
  );
  assert.equal(res.status, 200);
  const call = sqlCalls.find((c) => /INSERT INTO api_key_blocks/.test(c.text));
  // "[object Object]" in an audit note would be worse than no note at all.
  assert.ok(call!.values.includes(null));
});

// --- GET /api/v1/keys/status (#8611, tenant-visible) -------------------------

test("keys status: session-gated", async () => {
  const res = await fetchRoute(req("/api/v1/keys/status"), baseEnv());
  assert.equal(res.status, 401);
});

test("keys status: reports not-blocked for a clean account", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current = [[]];
  const res = await fetchRoute(
    req("/api/v1/keys/status", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { blocked: false });
});

test("keys status: reports the block WITHOUT the internal note", async () => {
  // The note is written by a maintainer for maintainers and can name a person,
  // a ticket or a suspicion. The route must never send it, and the response
  // shape gives the client nowhere to put it even by accident.
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current = [
    [
      {
        reason_code: "abuse_scraping",
        blocked_at: "1753800000000",
        note: "ticket 12 - suspect",
      },
    ],
  ];
  const res = await fetchRoute(
    req("/api/v1/keys/status", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  const body = (await res.json()) as Row;
  assert.equal(body.blocked, true);
  assert.equal(body.reason_code, "abuse_scraping");
  assert.match(String(body.message), /scraping/i);
  // blocked_at is BIGINT -> a string from postgres.js; the route coerces it.
  assert.strictEqual(body.blocked_at, 1753800000000);
  assert.ok(!JSON.stringify(body).includes("ticket 12"));
});

test("keys status: an unrecognised stored code degrades to abuse_manual", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current = [[{ reason_code: "legacy-code", blocked_at: "1" }]];
  const res = await fetchRoute(
    req("/api/v1/keys/status", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  const body = (await res.json()) as Row;
  assert.equal(body.blocked, true);
  assert.equal(body.reason_code, "abuse_manual");
});

test("anomalies: an account with no signals is omitted, not listed with an empty array", async () => {
  // A review queue that lists every active account with `signals: []` is a
  // queue nobody reads.
  const env = blockEnv();
  mockQueue.current = [
    [{ account_id: "9", day: "2026-07-01", route: "mcp", request_count: "3" }],
    [],
  ];
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/anomalies", null, BLOCK_TOKEN, "GET"),
    env,
  );
  const body = (await res.json()) as Row;
  assert.equal(body.accounts_seen, 1);
  assert.equal(body.flagged_count, 0);
  assert.deepEqual(body.flagged, []);
});

test("anomalies: 401 without the block token", async () => {
  const res = await fetchRoute(
    blockReq("/api/v1/internal/keys/anomalies", null, null, "GET"),
    blockEnv(),
  );
  assert.equal(res.status, 401);
});

// --- GET /api/v1/keys/usage (#8386) -----------------------------------------

test("keys usage: 401 when the session is missing", async () => {
  const env = baseEnv();
  const res = await fetchRoute(req("/api/v1/keys/usage"), env);
  assert.equal(res.status, 401);
});

test("keys usage: 200 aggregates by day and top routes, scoped to the session's account", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current.push([
    { day: "2026-07-20", route: "chain-events", request_count: 5 },
    { day: "2026-07-20", route: "chain-events/stats", request_count: 2 },
    { day: "2026-07-19", route: "chain-events", request_count: 3 },
  ]);
  const res = await fetchRoute(
    req("/api/v1/keys/usage", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.equal(body.window_days, 7);
  assert.deepEqual(body.days, [
    { day: "2026-07-20", count: 7 },
    { day: "2026-07-19", count: 3 },
  ]);
  assert.equal(body.top_routes[0].route, "chain-events");
  assert.equal(body.top_routes[0].count, 8);
  assert.ok(sqlCalls.some((c) => /account_id = /.test(c.text)));
});

test("keys usage: 200 with empty arrays when there's no usage yet", async () => {
  const env = baseEnv();
  const token = await sessionToken(7, "5Abc");
  mockQueue.current.push([]);
  const res = await fetchRoute(
    req("/api/v1/keys/usage", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.deepEqual(body.days, []);
  assert.deepEqual(body.top_routes, []);
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
  const calls: Row[] = [];
  vi.stubGlobal("fetch", async (url: unknown, opts: Row) => {
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
  const body = (await res.json()) as Row;
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
  const body = (await res.json()) as Row;
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

// #8640: reported from production. `challenge` returned 200 on a deployment
// with no WALLET_SESSION_SECRET, so the UI asked the user for a real wallet
// signature — an extension prompt — for a message `verify` was then guaranteed
// to reject with 503. The two endpoints must agree on the precondition.
test("challenge: 503 when WALLET_SESSION_SECRET is not provisioned", async () => {
  const wallet = makeTestWallet(11);
  const res = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    baseEnv({ WALLET_SESSION_SECRET: undefined }),
  );
  assert.equal(res.status, 503);
  const body = (await res.json()) as Row;
  assert.match(String(body.error), /not provisioned/);
});

test("challenge and verify agree: neither mints work the other cannot honour", async () => {
  // The invariant, stated directly: if verify would 503, challenge must not
  // hand back something to sign.
  const wallet = makeTestWallet(12);
  const env = baseEnv({ WALLET_SESSION_SECRET: undefined });
  const challenge = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const verify = await fetchRoute(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "0x00" },
    }),
    env,
  );
  assert.equal(challenge.status, verify.status);
  assert.equal(challenge.status, 503);
});
