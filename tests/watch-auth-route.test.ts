// Unit tests for wallet-verified alert-trigger issuance (#8374,
// workers/data-api.ts's handleWatchChallenge/handleWatchTokenMint). A
// dedicated test file mirroring tests/wallet-auth-keys-route.test.ts's own
// shape (same KV fake, same sr25519 test-wallet helper) -- these routes
// share src/wallet-auth.ts's primitives with the wallet-login pair but are
// a distinct surface (no Postgres write of their own; the write happens
// later, at actual trigger creation -- see tests/alert-triggers-route.test.ts's
// "wallet-verified path" section for that half).
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.ts";
import { verifyTriggerToken } from "../src/wallet-auth.ts";
import type { Row } from "./row-type.ts";

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
    _store: store,
  };
}

const TOKEN_SECRET = "test-watch-trigger-token-secret";

function baseEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    METAGRAPH_CONTROL: createFakeKv(),
    WATCH_TRIGGER_TOKEN_SECRET: TOKEN_SECRET,
    // #8640: /auth/wallet/challenge now refuses to mint a challenge on a
    // deployment with no WALLET_SESSION_SECRET, since /verify would reject the
    // resulting signature anyway. These tests exercise challenge behaviour, not
    // provisioning, so the base env is provisioned; the unprovisioned case has
    // its own test.
    WALLET_SESSION_SECRET: "test-wallet-session-secret",
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

// --- POST /api/v1/watch/challenges -------------------------------------

test("challenge: rejects a missing body (no ss58 field at all)", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/watch/challenges", {
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
    req("/api/v1/watch/challenges", {
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
    req("/api/v1/watch/challenges", {
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
    req("/api/v1/watch/challenges", {
      method: "POST",
      headers: { "content-length": "999999" },
      body: { ss58: "x" },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("challenge: 413 on a body that actually exceeds the byte limit (no content-length lie needed)", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/watch/challenges", {
      method: "POST",
      body: { ss58: "x".repeat(5000) },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("challenge: 400 on unparsable JSON body", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/watch/challenges", {
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
    req("/api/v1/watch/challenges", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 429);
});

test("challenge: 200 with a signable, watch-purpose message for a valid ss58", async () => {
  const wallet = makeTestWallet(3);
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/watch/challenges", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.match(body.message, new RegExp(wallet.ss58));
  assert.match(body.message, /^metagraph\.sh watch verification\n/);
  assert.ok(body.expires_in_seconds > 0);
});

test("challenge: a non-string ss58 (number/null/object) is coerced to empty and rejected, never passed through", async () => {
  const env = baseEnv();
  for (const ss58 of [42, null, { nested: true }, ["a"]]) {
    const res = await fetchRoute(
      req("/api/v1/watch/challenges", { method: "POST", body: { ss58 } }),
      env,
    );
    assert.equal(res.status, 400);
  }
});

test("challenge: a watch challenge and a login challenge for the same ss58 don't collide (distinct KV namespaces)", async () => {
  const wallet = makeTestWallet(4);
  const kv = createFakeKv();
  const env = baseEnv({ METAGRAPH_CONTROL: kv });
  await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  await fetchRoute(
    req("/api/v1/watch/challenges", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  assert.equal(kv._store.size, 2);
});

// --- POST /api/v1/watch/tokens ------------------------------------------

test("token: 503 when WATCH_TRIGGER_TOKEN_SECRET is not provisioned", async () => {
  const wallet = makeTestWallet(5);
  const env = baseEnv({ WATCH_TRIGGER_TOKEN_SECRET: undefined });
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("token: 429 when the wallet-auth rate limiter denies", async () => {
  const wallet = makeTestWallet(6);
  const env = baseEnv({
    WALLET_AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) },
  });
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 429);
});

test("token: 413 on an oversized body", async () => {
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: "x".repeat(5000), signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("token: 400 on unparsable JSON body", async () => {
  const env = baseEnv();
  const res = await worker.fetch(
    new Request("https://d/api/v1/watch/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
    env,
    {} as unknown as ExecutionContext,
  );
  assert.equal(res.status, 400);
});

test("token: 503 when the KV challenge store is unavailable (distinct from the WATCH_TRIGGER_TOKEN_SECRET 503)", async () => {
  const wallet = makeTestWallet(7);
  const env = baseEnv({ METAGRAPH_CONTROL: undefined });
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("token: 401 when no challenge was issued", async () => {
  const wallet = makeTestWallet(8);
  const env = baseEnv();
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature: "a".repeat(128) },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("token: a non-string ss58 or signature is coerced to empty and rejected, never passed through", async () => {
  const wallet = makeTestWallet(20);
  const env = baseEnv();
  // Non-string ss58 -> invalid_ss58 -> 401 (the anti-oracle collapse).
  for (const ss58 of [42, null, { nested: true }]) {
    const res = await fetchRoute(
      req("/api/v1/watch/tokens", {
        method: "POST",
        body: { ss58, signature: "a".repeat(128) },
      }),
      env,
    );
    assert.equal(res.status, 401);
  }
  // Valid ss58 with a non-string signature: a real challenge exists, so this
  // reaches (and fails) the signature-shape check rather than short-circuiting
  // on a missing challenge.
  for (const signature of [42, null, { nested: true }]) {
    await fetchRoute(
      req("/api/v1/watch/challenges", {
        method: "POST",
        body: { ss58: wallet.ss58 },
      }),
      env,
    );
    const res = await fetchRoute(
      req("/api/v1/watch/tokens", {
        method: "POST",
        body: { ss58: wallet.ss58, signature },
      }),
      env,
    );
    assert.equal(res.status, 401);
  }
});

test("token: 401 on a signature from the wrong keypair", async () => {
  const wallet = makeTestWallet(9);
  const impostor = makeTestWallet(90);
  const env = baseEnv();
  const challengeRes = await fetchRoute(
    req("/api/v1/watch/challenges", {
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
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("token: 401 when a wallet-login-purpose signature is presented (purpose confusion is rejected, not just discouraged)", async () => {
  const wallet = makeTestWallet(10);
  const env = baseEnv();
  // Issue and sign a LOGIN challenge, then try to redeem it as a watch token.
  const loginChallengeRes = await fetchRoute(
    req("/api/v1/auth/wallet/challenge", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const { message } = (await loginChallengeRes.json()) as Row;
  const signature = bytesToHex(
    sr25519Sign(wallet.secretKey, new TextEncoder().encode(message)),
  );
  const res = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  // No "watch" challenge was ever issued for this ss58 -- only a "login" one
  // (a different KV key) -- so this is a straightforward missing-challenge
  // 401, not a signature-shape failure. The two purposes never share state.
  assert.equal(res.status, 401);
});

test("token: 200 issues a verifiable, ss58-bound trigger token on a valid signature", async () => {
  const wallet = makeTestWallet(11);
  const env = baseEnv();
  const challengeRes = await fetchRoute(
    req("/api/v1/watch/challenges", {
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
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as Row;
  assert.ok(body.token);
  assert.equal(body.expires_in_seconds, 90 * 24 * 3600);
  const verified = await verifyTriggerToken(TOKEN_SECRET, body.token);
  assert.deepEqual(verified, { ss58: wallet.ss58 });
});

test("token: the nonce is single-use -- redeeming the same signature twice fails the second time", async () => {
  const wallet = makeTestWallet(12);
  const env = baseEnv();
  const challengeRes = await fetchRoute(
    req("/api/v1/watch/challenges", {
      method: "POST",
      body: { ss58: wallet.ss58 },
    }),
    env,
  );
  const { message } = (await challengeRes.json()) as Row;
  const signature = bytesToHex(
    sr25519Sign(wallet.secretKey, new TextEncoder().encode(message)),
  );
  const first = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(first.status, 200);
  const second = await fetchRoute(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: wallet.ss58, signature },
    }),
    env,
  );
  assert.equal(second.status, 401);
});
