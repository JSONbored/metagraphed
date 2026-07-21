import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.ts";
import { signPayload } from "../src/webhooks.mjs";
import {
  createSessionToken,
  issueWalletChallenge,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  verifyWalletChallenge,
  WALLET_CHALLENGE_TTL_SECONDS,
  walletChallengeMessage,
} from "../src/wallet-auth.mjs";

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
    _store: store,
  };
}

// A deterministic test "wallet": a real sr25519 keypair + its ss58 address,
// so verifyWalletChallenge exercises the actual @scure/sr25519 verify path
// rather than a mock.
function makeTestWallet(seedByte) {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i + seedByte) % 256);
  const secretKey = secretFromSeed(seed);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, ss58: encodeAccountId32(publicKey) };
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("walletChallengeMessage", () => {
  test("is deterministic given the same ss58 + nonce", () => {
    const a = walletChallengeMessage("5Abc", "nonce1");
    const b = walletChallengeMessage("5Abc", "nonce1");
    assert.equal(a, b);
    assert.match(a, /5Abc/);
    assert.match(a, /nonce1/);
  });

  test("differs for a different ss58 or nonce", () => {
    const base = walletChallengeMessage("5Abc", "nonce1");
    assert.notEqual(walletChallengeMessage("5Xyz", "nonce1"), base);
    assert.notEqual(walletChallengeMessage("5Abc", "nonce2"), base);
  });
});

describe("issueWalletChallenge", () => {
  test("rejects a malformed ss58 address", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await issueWalletChallenge(env, "not-an-address");
    assert.deepEqual(result, { ok: false, code: "invalid_ss58" });
  });

  test("rejects when the KV binding is unavailable", async () => {
    const wallet = makeTestWallet(1);
    const result = await issueWalletChallenge({}, wallet.ss58);
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_store_unavailable",
    });
  });

  test("issues a signable message and stores its nonce in KV", async () => {
    const wallet = makeTestWallet(2);
    const kv = createFakeKv();
    const env = { METAGRAPH_CONTROL: kv };
    const result = await issueWalletChallenge(env, wallet.ss58);
    assert.equal(result.ok, true);
    assert.equal(result.expiresInSeconds, WALLET_CHALLENGE_TTL_SECONDS);
    assert.match(result.message, new RegExp(wallet.ss58));
    assert.equal(kv._store.size, 1);
  });

  test("is not deterministic across calls (fresh nonce each time)", async () => {
    const wallet = makeTestWallet(3);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const first = await issueWalletChallenge(env, wallet.ss58);
    const second = await issueWalletChallenge(env, wallet.ss58);
    assert.notEqual(first.message, second.message);
  });
});

describe("verifyWalletChallenge", () => {
  test("rejects a malformed ss58 address", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await verifyWalletChallenge(env, "not-an-address", "ab");
    assert.deepEqual(result, { ok: false, code: "invalid_ss58" });
  });

  test("rejects when the KV binding is unavailable", async () => {
    const wallet = makeTestWallet(4);
    const result = await verifyWalletChallenge({}, wallet.ss58, "ab");
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_store_unavailable",
    });
  });

  test("rejects when no challenge was issued (expired or never requested)", async () => {
    const wallet = makeTestWallet(5);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const result = await verifyWalletChallenge(
      env,
      wallet.ss58,
      "a".repeat(128),
    );
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_expired_or_missing",
    });
  });

  test("rejects a malformed signature (wrong length / non-hex)", async () => {
    const wallet = makeTestWallet(6);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    // Each attempt gets its own fresh challenge -- verifyWalletChallenge
    // consumes the nonce on every call regardless of outcome (single-use),
    // so reusing one challenge across assertions would fail the second on
    // "expired_or_missing" rather than the signature-shape check under test.
    await issueWalletChallenge(env, wallet.ss58);
    assert.deepEqual(await verifyWalletChallenge(env, wallet.ss58, "short"), {
      ok: false,
      code: "invalid_signature",
    });
    await issueWalletChallenge(env, wallet.ss58);
    assert.deepEqual(
      await verifyWalletChallenge(env, wallet.ss58, "z".repeat(128)),
      { ok: false, code: "invalid_signature" },
    );
  });

  test("accepts a real sr25519 signature over the issued challenge (happy path)", async () => {
    const wallet = makeTestWallet(7);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const challenge = await issueWalletChallenge(env, wallet.ss58);
    const signature = sr25519Sign(
      wallet.secretKey,
      new TextEncoder().encode(challenge.message),
    );
    const result = await verifyWalletChallenge(
      env,
      wallet.ss58,
      bytesToHex(signature),
    );
    assert.deepEqual(result, { ok: true });
  });

  test("the nonce is single-use -- a second verify with the same signature fails", async () => {
    const wallet = makeTestWallet(8);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const challenge = await issueWalletChallenge(env, wallet.ss58);
    const signature = bytesToHex(
      sr25519Sign(
        wallet.secretKey,
        new TextEncoder().encode(challenge.message),
      ),
    );
    assert.deepEqual(await verifyWalletChallenge(env, wallet.ss58, signature), {
      ok: true,
    });
    assert.deepEqual(await verifyWalletChallenge(env, wallet.ss58, signature), {
      ok: false,
      code: "challenge_expired_or_missing",
    });
  });

  test("rejects a signature produced by a different keypair", async () => {
    const wallet = makeTestWallet(9);
    const impostor = makeTestWallet(99);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    const challenge = await issueWalletChallenge(env, wallet.ss58);
    const signature = bytesToHex(
      sr25519Sign(
        impostor.secretKey,
        new TextEncoder().encode(challenge.message),
      ),
    );
    const result = await verifyWalletChallenge(env, wallet.ss58, signature);
    assert.deepEqual(result, { ok: false, code: "invalid_signature" });
  });

  test("rejects a well-formed-hex signature @scure/sr25519 itself rejects (missing Schnorrkel marker)", async () => {
    const wallet = makeTestWallet(11);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    await issueWalletChallenge(env, wallet.ss58);
    // 64 bytes of valid hex, but the last byte's top bit is unset -- @scure/
    // sr25519's verify() throws "Schnorrkel marker missing" for this, rather
    // than returning false, so this exercises the catch-and-fold-to-
    // invalid_signature branch instead of the plain "verified === false" one.
    const signature = `${"aa".repeat(63)}00`;
    const result = await verifyWalletChallenge(env, wallet.ss58, signature);
    assert.deepEqual(result, { ok: false, code: "invalid_signature" });
  });

  test("rejects a signature over a different message (tampered/replayed)", async () => {
    const wallet = makeTestWallet(10);
    const env = { METAGRAPH_CONTROL: createFakeKv() };
    await issueWalletChallenge(env, wallet.ss58);
    const signature = bytesToHex(
      sr25519Sign(
        wallet.secretKey,
        new TextEncoder().encode("some other message"),
      ),
    );
    const result = await verifyWalletChallenge(env, wallet.ss58, signature);
    assert.deepEqual(result, { ok: false, code: "invalid_signature" });
  });
});

describe("createSessionToken / verifySessionToken", () => {
  const SECRET = "test-session-secret";

  test("round-trips accountId + ss58", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 42,
      ss58: "5Abc",
    });
    const verified = await verifySessionToken(SECRET, token);
    assert.deepEqual(verified, { accountId: 42, ss58: "5Abc" });
  });

  test("is not a plain concatenation -- has exactly one signature suffix", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 1,
      ss58: "5X",
    });
    assert.equal(token.split(".").length, 2);
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 1,
      ss58: "5X",
    });
    assert.equal(await verifySessionToken("wrong-secret", token), null);
  });

  test("rejects a tampered payload segment", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 1,
      ss58: "5X",
    });
    const [encoded, signature] = token.split(".");
    const tampered = `${encoded}x.${signature}`;
    assert.equal(await verifySessionToken(SECRET, tampered), null);
  });

  test("rejects a tampered signature segment", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 1,
      ss58: "5X",
    });
    const [encoded, signature] = token.split(".");
    const flipped =
      signature[0] === "a"
        ? "b" + signature.slice(1)
        : "a" + signature.slice(1);
    assert.equal(
      await verifySessionToken(SECRET, `${encoded}.${flipped}`),
      null,
    );
  });

  test("rejects malformed tokens", async () => {
    assert.equal(await verifySessionToken(SECRET, ""), null);
    assert.equal(await verifySessionToken(SECRET, null), null);
    assert.equal(await verifySessionToken(SECRET, undefined), null);
    assert.equal(await verifySessionToken(SECRET, "no-dot-here"), null);
    assert.equal(await verifySessionToken(SECRET, "."), null);
  });

  test("rejects an expired token", async () => {
    // Hand-build a token with an already-past exp using the same encoding
    // scheme (base64url of the UTF-8 JSON payload) + the real signPayload
    // primitive this module signs with, rather than waiting out the TTL.
    const payload = { account_id: 7, ss58: "5Expired", exp: 0 };
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signature = await signPayload(SECRET, encoded);
    const token = `${encoded}.${signature}`;
    assert.equal(await verifySessionToken(SECRET, token), null);
  });

  test("rejects a well-signed token whose payload segment isn't valid base64/JSON", async () => {
    // The signature is computed FROM the encoded segment, so any string can
    // be correctly signed regardless of whether it's valid base64url/JSON --
    // this exercises the decode-failure catch branch, not a signature
    // mismatch.
    const encoded = "!!!not-base64-or-json!!!";
    const signature = await signPayload(SECRET, encoded);
    assert.equal(
      await verifySessionToken(SECRET, `${encoded}.${signature}`),
      null,
    );
  });

  test("rejects a well-signed but shape-invalid payload", async () => {
    const encoded = btoa(JSON.stringify({ nope: true }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signature = await signPayload(SECRET, encoded);
    assert.equal(
      await verifySessionToken(SECRET, `${encoded}.${signature}`),
      null,
    );
  });

  test("SESSION_TTL_SECONDS is a sane positive duration", () => {
    assert.ok(SESSION_TTL_SECONDS > 0);
  });
});
