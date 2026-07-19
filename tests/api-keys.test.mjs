import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  API_KEY_PATTERN,
  generateApiKey,
  hashApiKeySecret,
  isValidApiKeySecret,
  isValidOwnerContact,
  parseApiKey,
} from "../src/api-keys.mjs";

describe("generateApiKey", () => {
  test("produces a key matching the documented format", () => {
    const { full, prefix, secret } = generateApiKey();
    assert.match(full, API_KEY_PATTERN);
    assert.equal(full, `mg_${prefix}_${secret}`);
    assert.equal(prefix.length, 16);
    assert.equal(secret.length, 64);
    assert.match(prefix, /^[0-9a-f]{16}$/);
    assert.match(secret, /^[0-9a-f]{64}$/);
  });

  test("is not deterministic across calls", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.notEqual(a.full, b.full);
    assert.notEqual(a.prefix, b.prefix);
    assert.notEqual(a.secret, b.secret);
  });
});

describe("parseApiKey", () => {
  test("parses a bare key", () => {
    const { full, prefix, secret } = generateApiKey();
    assert.deepEqual(parseApiKey(full), { prefix, secret });
  });

  test("parses a Bearer-prefixed header value", () => {
    const { full, prefix, secret } = generateApiKey();
    assert.deepEqual(parseApiKey(`Bearer ${full}`), { prefix, secret });
  });

  test("returns null for non-string input", () => {
    assert.equal(parseApiKey(undefined), null);
    assert.equal(parseApiKey(null), null);
    assert.equal(parseApiKey(42), null);
  });

  test("returns null for a malformed key", () => {
    assert.equal(parseApiKey(""), null);
    assert.equal(parseApiKey("mg_short_short"), null);
    assert.equal(parseApiKey("not-a-key-at-all"), null);
    assert.equal(
      parseApiKey(`sk_${"a".repeat(16)}_${"b".repeat(64)}`), // wrong tag
      null,
    );
  });

  test("returns null for an uppercase-hex key (case-sensitive)", () => {
    const { full } = generateApiKey();
    assert.equal(parseApiKey(full.toUpperCase()), null);
  });
});

describe("hashApiKeySecret / isValidApiKeySecret", () => {
  test("hashes to a stable 64-hex-char SHA-256 digest", async () => {
    const hash = await hashApiKeySecret("abc");
    assert.match(hash, /^[0-9a-f]{64}$/);
    // Known SHA-256("abc") golden value.
    assert.equal(
      hash,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("never stores/exposes the plaintext secret -- validates by re-hashing", async () => {
    const { secret } = generateApiKey();
    const storedHash = await hashApiKeySecret(secret);
    assert.equal(await isValidApiKeySecret(secret, storedHash), true);
  });

  test("rejects a wrong secret against a stored hash", async () => {
    const { secret: secretA } = generateApiKey();
    const { secret: secretB } = generateApiKey();
    const storedHash = await hashApiKeySecret(secretA);
    assert.equal(await isValidApiKeySecret(secretB, storedHash), false);
  });

  test("rejects empty/non-string secrets or hashes", async () => {
    assert.equal(await isValidApiKeySecret("", "somehash"), false);
    assert.equal(await isValidApiKeySecret("secret", ""), false);
    assert.equal(await isValidApiKeySecret(undefined, "somehash"), false);
    assert.equal(await isValidApiKeySecret("secret", undefined), false);
    assert.equal(await isValidApiKeySecret(null, null), false);
  });
});

describe("isValidOwnerContact", () => {
  test("accepts a plausible email", () => {
    assert.equal(isValidOwnerContact("dev@example.com"), true);
    assert.equal(isValidOwnerContact("a.b+tag@sub.example.co"), true);
  });

  test("rejects obviously-wrong shapes", () => {
    assert.equal(isValidOwnerContact(""), false);
    assert.equal(isValidOwnerContact("not-an-email"), false);
    assert.equal(isValidOwnerContact("missing-domain@"), false);
    assert.equal(isValidOwnerContact("@missing-local.com"), false);
    assert.equal(isValidOwnerContact(undefined), false);
    assert.equal(isValidOwnerContact(42), false);
  });
});
