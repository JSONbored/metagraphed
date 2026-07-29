import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  getPublicKey,
  secretFromSeed,
  sign as sr25519Sign,
} from "@scure/sr25519";
import { encodeAccountId32 } from "../src/ss58.ts";
import { signPayload } from "../src/webhooks.ts";
import {
  createSessionToken,
  createTriggerToken,
  issueWalletChallenge,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  verifyTriggerToken,
  challengeSignatureForms,
  verifyWalletChallenge,
  WALLET_CHALLENGE_TTL_SECONDS,
  walletChallengeMessage,
  WATCH_TOKEN_TTL_SECONDS,
} from "../src/wallet-auth.ts";
import type { Row } from "./row-type.ts";

function createFakeKv() {
  const store = new Map<string, unknown>();
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

// A deterministic test "wallet": a real sr25519 keypair + its ss58 address,
// so verifyWalletChallenge exercises the actual @scure/sr25519 verify path
// rather than a mock.
function makeTestWallet(seedByte: number) {
  const seed = Uint8Array.from({ length: 32 }, (_, i) => (i + seedByte) % 256);
  const secretKey = secretFromSeed(seed);
  const publicKey = getPublicKey(secretKey);
  return { secretKey, publicKey, ss58: encodeAccountId32(publicKey)! };
}

function bytesToHex(bytes: Uint8Array) {
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

  test("defaults to the original login preamble, unchanged", () => {
    assert.equal(
      walletChallengeMessage("5Abc", "nonce1"),
      walletChallengeMessage("5Abc", "nonce1", "login"),
    );
    assert.match(
      walletChallengeMessage("5Abc", "nonce1"),
      /^metagraphed wallet login\n/,
    );
  });

  test("#8374: the watch purpose gets a distinct preamble, so a login signature can't double as a watch-token signature", () => {
    const login = walletChallengeMessage("5Abc", "nonce1", "login");
    const watch = walletChallengeMessage("5Abc", "nonce1", "watch");
    assert.notEqual(login, watch);
    assert.match(watch, /^metagraph\.sh watch verification\n/);
    assert.match(watch, /5Abc/);
    assert.match(watch, /nonce1/);
  });
});

describe("issueWalletChallenge", () => {
  test("rejects a malformed ss58 address", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const result = (await issueWalletChallenge(env, "not-an-address")) as Row;
    assert.deepEqual(result, { ok: false, code: "invalid_ss58" });
  });

  test("rejects when the KV binding is unavailable", async () => {
    const wallet = makeTestWallet(1);
    const result = (await issueWalletChallenge(
      {} as unknown as Env,
      wallet.ss58,
    )) as Row;
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_store_unavailable",
    });
  });

  test("issues a signable message and stores its nonce in KV", async () => {
    const wallet = makeTestWallet(2);
    const kv = createFakeKv();
    const env = { METAGRAPH_CONTROL: kv } as unknown as Env;
    const result = (await issueWalletChallenge(env, wallet.ss58)) as Row;
    assert.equal(result.ok, true);
    assert.equal(result.expiresInSeconds, WALLET_CHALLENGE_TTL_SECONDS);
    assert.match(result.message, new RegExp(wallet.ss58));
    assert.equal(kv._store.size, 1);
  });

  test("is not deterministic across calls (fresh nonce each time)", async () => {
    const wallet = makeTestWallet(3);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const first = (await issueWalletChallenge(env, wallet.ss58)) as Row;
    const second = (await issueWalletChallenge(env, wallet.ss58)) as Row;
    assert.notEqual(first.message, second.message);
  });

  test("#8374: a login challenge and a watch challenge for the same ss58 don't clobber each other's KV nonce", async () => {
    const wallet = makeTestWallet(12);
    const kv = createFakeKv();
    const env = { METAGRAPH_CONTROL: kv } as unknown as Env;
    const login = (await issueWalletChallenge(
      env,
      wallet.ss58,
      "login",
    )) as Row;
    const watch = (await issueWalletChallenge(
      env,
      wallet.ss58,
      "watch",
    )) as Row;
    // Two distinct KV keys, both still present -- issuing "watch" did not
    // evict "login"'s pending challenge.
    assert.equal(kv._store.size, 2);
    assert.notEqual(login.message, watch.message);
    // Both are still independently verifiable.
    const loginSig = bytesToHex(
      sr25519Sign(wallet.secretKey, new TextEncoder().encode(login.message)),
    );
    assert.deepEqual(
      await verifyWalletChallenge(env, wallet.ss58, loginSig, "login"),
      { ok: true },
    );
    const watchSig = bytesToHex(
      sr25519Sign(wallet.secretKey, new TextEncoder().encode(watch.message)),
    );
    assert.deepEqual(
      await verifyWalletChallenge(env, wallet.ss58, watchSig, "watch"),
      { ok: true },
    );
  });
});

describe("verifyWalletChallenge", () => {
  test("rejects a malformed ss58 address", async () => {
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const result = (await verifyWalletChallenge(
      env,
      "not-an-address",
      "ab",
    )) as Row;
    assert.deepEqual(result, { ok: false, code: "invalid_ss58" });
  });

  test("rejects when the KV binding is unavailable", async () => {
    const wallet = makeTestWallet(4);
    const result = (await verifyWalletChallenge(
      {} as unknown as Env,
      wallet.ss58,
      "ab",
    )) as Row;
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_store_unavailable",
    });
  });

  test("rejects when no challenge was issued (expired or never requested)", async () => {
    const wallet = makeTestWallet(5);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const result = (await verifyWalletChallenge(
      env,
      wallet.ss58,
      "a".repeat(128),
    )) as Row;
    assert.deepEqual(result, {
      ok: false,
      code: "challenge_expired_or_missing",
    });
  });

  test("rejects a malformed signature (wrong length / non-hex)", async () => {
    const wallet = makeTestWallet(6);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
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
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const challenge = (await issueWalletChallenge(env, wallet.ss58)) as Row;
    const signature = sr25519Sign(
      wallet.secretKey,
      new TextEncoder().encode(challenge.message),
    );
    const result = (await verifyWalletChallenge(
      env,
      wallet.ss58,
      bytesToHex(signature),
    )) as Row;
    assert.deepEqual(result, { ok: true });
  });

  test("#8374: a signature over a watch-purpose challenge does not verify against a login-purpose challenge sharing the same nonce text, and vice versa", async () => {
    const wallet = makeTestWallet(13);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const watchChallenge = (await issueWalletChallenge(
      env,
      wallet.ss58,
      "watch",
    )) as Row;
    const watchSignature = bytesToHex(
      sr25519Sign(
        wallet.secretKey,
        new TextEncoder().encode(watchChallenge.message),
      ),
    );
    // Verifying that signature against the "login" purpose fails outright --
    // there's no pending login challenge for this ss58 at all, since only a
    // "watch" one was ever issued (the KV keys are namespaced separately).
    assert.deepEqual(
      await verifyWalletChallenge(env, wallet.ss58, watchSignature, "login"),
      { ok: false, code: "challenge_expired_or_missing" },
    );
  });

  test("the nonce is single-use -- a second verify with the same signature fails", async () => {
    const wallet = makeTestWallet(8);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const challenge = (await issueWalletChallenge(env, wallet.ss58)) as Row;
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
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    const challenge = (await issueWalletChallenge(env, wallet.ss58)) as Row;
    const signature = bytesToHex(
      sr25519Sign(
        impostor.secretKey,
        new TextEncoder().encode(challenge.message),
      ),
    );
    const result = (await verifyWalletChallenge(
      env,
      wallet.ss58,
      signature,
    )) as Row;
    assert.deepEqual(result, { ok: false, code: "invalid_signature" });
  });

  test("rejects a well-formed-hex signature @scure/sr25519 itself rejects (missing Schnorrkel marker)", async () => {
    const wallet = makeTestWallet(11);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    await issueWalletChallenge(env, wallet.ss58);
    // 64 bytes of valid hex, but the last byte's top bit is unset -- @scure/
    // sr25519's verify() throws "Schnorrkel marker missing" for this, rather
    // than returning false, so this exercises the catch-and-fold-to-
    // invalid_signature branch instead of the plain "verified === false" one.
    const signature = `${"aa".repeat(63)}00`;
    const result = (await verifyWalletChallenge(
      env,
      wallet.ss58,
      signature,
    )) as Row;
    assert.deepEqual(result, { ok: false, code: "invalid_signature" });
  });

  test("rejects a signature over a different message (tampered/replayed)", async () => {
    const wallet = makeTestWallet(10);
    const env = { METAGRAPH_CONTROL: createFakeKv() } as unknown as Env;
    await issueWalletChallenge(env, wallet.ss58);
    const signature = bytesToHex(
      sr25519Sign(
        wallet.secretKey,
        new TextEncoder().encode("some other message"),
      ),
    );
    const result = (await verifyWalletChallenge(
      env,
      wallet.ss58,
      signature,
    )) as Row;
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

describe("createTriggerToken / verifyTriggerToken (#8374)", () => {
  const SECRET = "test-trigger-secret";

  test("round-trips ss58", async () => {
    const token = await createTriggerToken(SECRET, { ss58: "5Abc" });
    const verified = await verifyTriggerToken(SECRET, token);
    assert.deepEqual(verified, { ss58: "5Abc" });
  });

  test("is not a plain concatenation -- has exactly one signature suffix", async () => {
    const token = await createTriggerToken(SECRET, { ss58: "5X" });
    assert.equal(token.split(".").length, 2);
  });

  test("rejects a token signed with a different secret", async () => {
    const token = await createTriggerToken(SECRET, { ss58: "5X" });
    assert.equal(await verifyTriggerToken("wrong-secret", token), null);
  });

  test("rejects a tampered payload segment", async () => {
    const token = await createTriggerToken(SECRET, { ss58: "5X" });
    const [encoded, signature] = token.split(".");
    const tampered = `${encoded}x.${signature}`;
    assert.equal(await verifyTriggerToken(SECRET, tampered), null);
  });

  test("rejects a tampered signature segment", async () => {
    const token = await createTriggerToken(SECRET, { ss58: "5X" });
    const [encoded, signature] = token.split(".");
    const flipped =
      signature[0] === "a"
        ? "b" + signature.slice(1)
        : "a" + signature.slice(1);
    assert.equal(
      await verifyTriggerToken(SECRET, `${encoded}.${flipped}`),
      null,
    );
  });

  test("rejects malformed tokens", async () => {
    assert.equal(await verifyTriggerToken(SECRET, ""), null);
    assert.equal(await verifyTriggerToken(SECRET, null), null);
    assert.equal(await verifyTriggerToken(SECRET, undefined), null);
    assert.equal(await verifyTriggerToken(SECRET, "no-dot-here"), null);
    assert.equal(await verifyTriggerToken(SECRET, "."), null);
  });

  test("rejects an expired token", async () => {
    const payload = { ss58: "5Expired", purpose: "trigger", exp: 0 };
    const encoded = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signature = await signPayload(SECRET, encoded);
    const token = `${encoded}.${signature}`;
    assert.equal(await verifyTriggerToken(SECRET, token), null);
  });

  test("rejects a well-signed token whose payload segment isn't valid base64/JSON", async () => {
    const encoded = "!!!not-base64-or-json!!!";
    const signature = await signPayload(SECRET, encoded);
    assert.equal(
      await verifyTriggerToken(SECRET, `${encoded}.${signature}`),
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
      await verifyTriggerToken(SECRET, `${encoded}.${signature}`),
      null,
    );
  });

  test("rejects a well-signed session token presented as a trigger token (purpose confusion)", async () => {
    // A session token has no `purpose` field at all -- shares this module's
    // signing primitive, so a token minted for one kind must not verify as
    // the other even under the SAME secret (defense in depth on top of the
    // fact that these ship with distinct secrets in production).
    const sessionToken = await createSessionToken(SECRET, {
      accountId: 1,
      ss58: "5X",
    });
    assert.equal(await verifyTriggerToken(SECRET, sessionToken), null);
  });

  test("WATCH_TOKEN_TTL_SECONDS is 90 days", () => {
    assert.equal(WATCH_TOKEN_TTL_SECONDS, 90 * 24 * 3600);
  });
});

describe("browser-extension <Bytes> wrapping (#8645)", () => {
  // Polkadot extensions do not sign the bytes handed to signRaw({type:"bytes"}).
  // They wrap them in <Bytes>…</Bytes> first, so a dapp cannot trick a user into
  // blind-signing something that is really an extrinsic payload. We verified only
  // the unwrapped form, so EVERY signature from a real wallet failed with
  // "signature verification failed" — while these tests stayed green, because
  // @scure/sr25519 signs the bare bytes and never wraps.
  const enc = new TextEncoder();
  const wrap = (msg: string) =>
    new Uint8Array([
      ...enc.encode("<Bytes>"),
      ...enc.encode(msg),
      ...enc.encode("</Bytes>"),
    ]);

  function wallet(seedByte: number) {
    const seed = Uint8Array.from(
      { length: 32 },
      (_, i) => (i + seedByte) % 256,
    );
    const secretKey = secretFromSeed(seed);
    const publicKey = getPublicKey(secretKey);
    return { secretKey, ss58: encodeAccountId32(publicKey)! };
  }
  const hex = (u: Uint8Array) =>
    [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

  async function envWithNonce(ss58: string, purpose?: "login" | "watch") {
    const kv = createFakeKv();
    const env = { METAGRAPH_CONTROL: kv } as unknown as Env;
    await issueWalletChallenge(env, ss58, purpose);
    const nonce = [
      ...(kv as unknown as { _store: Map<string, unknown> })._store.values(),
    ][0];
    return { env, nonce: String(nonce) };
  }

  test("accepts a signature wrapped the way a real extension wraps it", async () => {
    const { secretKey, ss58 } = wallet(31);
    const { env, nonce } = await envWithNonce(ss58);
    const signature = hex(
      sr25519Sign(secretKey, wrap(walletChallengeMessage(ss58, nonce))),
    );
    assert.deepEqual(await verifyWalletChallenge(env, ss58, signature), {
      ok: true,
    });
  });

  test("still accepts a bare signature, so CLI and service signers keep working", async () => {
    const { secretKey, ss58 } = wallet(32);
    const { env, nonce } = await envWithNonce(ss58);
    const signature = hex(
      sr25519Sign(secretKey, enc.encode(walletChallengeMessage(ss58, nonce))),
    );
    assert.deepEqual(await verifyWalletChallenge(env, ss58, signature), {
      ok: true,
    });
  });

  test("wrapping is honoured for the watch purpose too, not just login", async () => {
    const { secretKey, ss58 } = wallet(33);
    const { env, nonce } = await envWithNonce(ss58, "watch");
    const signature = hex(
      sr25519Sign(
        secretKey,
        wrap(walletChallengeMessage(ss58, nonce, "watch")),
      ),
    );
    assert.deepEqual(
      await verifyWalletChallenge(env, ss58, signature, "watch"),
      { ok: true },
    );
  });

  test("a wrapped signature over a DIFFERENT nonce is still rejected", async () => {
    // Accepting two framings must not accept two messages.
    const { secretKey, ss58 } = wallet(34);
    const { env } = await envWithNonce(ss58);
    const signature = hex(
      sr25519Sign(
        secretKey,
        wrap(walletChallengeMessage(ss58, "not-the-nonce")),
      ),
    );
    assert.deepEqual(await verifyWalletChallenge(env, ss58, signature), {
      ok: false,
      code: "invalid_signature",
    });
  });

  test("challengeSignatureForms returns exactly the wrapped and bare byte strings", () => {
    const [wrapped, bare] = challengeSignatureForms(enc.encode("hello"));
    assert.equal(new TextDecoder().decode(wrapped), "<Bytes>hello</Bytes>");
    assert.equal(new TextDecoder().decode(bare!), "hello");
  });
});

describe("session token account_id type (#8607)", () => {
  const SECRET = "test-session-secret";
  // The launch blocker for API-key issuance. `rpc_accounts.id` is a BIGSERIAL
  // and the Postgres driver surfaces it as a STRING, so handleWalletVerify
  // passed `accountId: "1"` while verifySessionToken demanded a number — and
  // rejected every session it had just issued. Verified against production:
  // verify returned 200 with a token, and POST /api/v1/keys answered 401
  // account_key_unauthorized with that exact token.
  //
  // The 62 route tests never caught it because their helper is
  // `sessionToken(accountId = 1)` — a number literal. Same shape as #8646 and
  // #8650: the fixture did not match the type production actually produces.

  test("a token minted from a Postgres STRING id verifies", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: "1",
      ss58: "5Dummy",
    });
    assert.deepEqual(await verifySessionToken(SECRET, token), {
      accountId: 1,
      ss58: "5Dummy",
    });
  });

  test("accountId comes back as a NUMBER regardless of how it went in", async () => {
    // Callers index rows and compare ids with it; a string would silently
    // break `===` comparisons downstream.
    for (const input of [7, "7"] as Array<number | string>) {
      const token = await createSessionToken(SECRET, {
        accountId: input,
        ss58: "5Dummy",
      });
      const session = await verifySessionToken(SECRET, token);
      assert.equal(typeof session?.accountId, "number");
      assert.equal(session?.accountId, 7);
    }
  });

  test("a number id still verifies — the original path is unchanged", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: 42,
      ss58: "5Dummy",
    });
    assert.equal((await verifySessionToken(SECRET, token))?.accountId, 42);
  });

  test("a non-numeric account_id is still rejected", async () => {
    // Widening the shape check must not make it meaningless.
    const encoded = Buffer.from(
      JSON.stringify({
        account_id: "not-a-number",
        ss58: "5Dummy",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    ).toString("base64url");
    const forged = `${encoded}.${await signPayload(SECRET, encoded)}`;
    assert.equal(await verifySessionToken(SECRET, forged), null);
  });

  test("a forged signature is still rejected for a string id", async () => {
    const token = await createSessionToken(SECRET, {
      accountId: "1",
      ss58: "5Dummy",
    });
    const tampered = `${token.slice(0, token.lastIndexOf(".") + 1)}${"0".repeat(64)}`;
    assert.equal(await verifySessionToken(SECRET, tampered), null);
  });
});
