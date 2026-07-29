import { describe, expect, it } from "vitest";
import {
  MAX_PAYLOAD_BYTES,
  base64UrlToBytes,
  bytesToBase64Url,
  buildPushRequest,
  encryptPushPayload,
  isExpiredSubscriptionStatus,
  isValidPushKeyMaterial,
  pushAudience,
  signVapidJwt,
  type VapidKeys,
} from "../src/web-push.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A throwaway VAPID keypair generated per run — never a committed secret. */
async function makeVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKey = bytesToBase64Url(
    new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
  );
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  return {
    publicKey,
    signingKey: jwk.d as string,
    subject: "mailto:ops@metagraph.sh",
  };
}

/** Stand in for a browser: produce a subscription and keep the private key so
 * the test can actually DECRYPT what the sender produced. */
async function makeSubscriber(
  endpoint = "https://fcm.googleapis.com/fcm/send/abc123",
) {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: {
      endpoint,
      p256dh: bytesToBase64Url(raw),
      auth: bytesToBase64Url(auth),
    },
    privateKey: pair.privateKey,
    publicRaw: raw,
    authSecret: auth,
  };
}

/** The receiver half of RFC 8291, so the round-trip is verified end to end
 * rather than by asserting our own byte layout back at ourselves. */
async function decryptAsBrowser(
  body: Uint8Array,
  sub: Awaited<ReturnType<typeof makeSubscriber>>,
): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const serverKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: serverKey } as unknown as Parameters<
        SubtleCrypto["deriveBits"]
      >[0],
      sub.privateKey,
      256,
    ),
  );

  const hkdf = async (
    s: Uint8Array,
    ikm: Uint8Array,
    info: Uint8Array,
    len: number,
  ) => {
    const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
      "deriveBits",
    ]);
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: s, info },
        k,
        len * 8,
      ),
    );
  };

  const prkInfo = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...sub.publicRaw,
    ...asPublic,
  ]);
  const ikm = await hkdf(sub.authSecret, shared, prkInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      ciphertext,
    ),
  );
  // Strip the trailing 0x02 last-record delimiter.
  return decoder.decode(plain.slice(0, -1));
}

describe("web-push crypto (#8385)", () => {
  it("round-trips a payload a real browser could decrypt (RFC 8291)", async () => {
    const sub = await makeSubscriber();
    const message = JSON.stringify({
      title: "SN64 registered a neuron",
      url: "/subnets/64",
    });
    const body = await encryptPushPayload(message, sub.subscription);
    expect(await decryptAsBrowser(body, sub)).toBe(message);
  });

  it("emits the RFC 8188 header layout: salt | rs | idlen | key | ciphertext", async () => {
    const sub = await makeSubscriber();
    const body = await encryptPushPayload("hi", sub.subscription);
    expect(body.slice(0, 16)).toHaveLength(16);
    // rs is big-endian 4096.
    expect(
      new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false),
    ).toBe(4096);
    expect(body[20]).toBe(65); // uncompressed P-256 point length
    expect(body[21]).toBe(0x04); // uncompressed point marker
  });

  it("never reuses salt or ephemeral key across two sends to the same device", async () => {
    // Reuse would leak plaintext relationships to the relaying push service.
    const sub = await makeSubscriber();
    const a = await encryptPushPayload("same text", sub.subscription);
    const b = await encryptPushPayload("same text", sub.subscription);
    expect(bytesToBase64Url(a.slice(0, 16))).not.toBe(
      bytesToBase64Url(b.slice(0, 16)),
    );
    expect(bytesToBase64Url(a.slice(21, 86))).not.toBe(
      bytesToBase64Url(b.slice(21, 86)),
    );
    // ...and both still decrypt to the same plaintext.
    expect(await decryptAsBrowser(a, sub)).toBe("same text");
    expect(await decryptAsBrowser(b, sub)).toBe("same text");
  });

  it("refuses a payload over the 2KB ceiling instead of emitting an oversized body", async () => {
    const sub = await makeSubscriber();
    await expect(
      encryptPushPayload("x".repeat(MAX_PAYLOAD_BYTES + 1), sub.subscription),
    ).rejects.toThrow(/exceeds/);
  });

  it("accepts a payload exactly at the ceiling", async () => {
    const sub = await makeSubscriber();
    const body = await encryptPushPayload(
      "x".repeat(MAX_PAYLOAD_BYTES),
      sub.subscription,
    );
    expect(body.length).toBeGreaterThan(MAX_PAYLOAD_BYTES);
  });

  it("signs a verifiable ES256 VAPID JWT audienced to the service ORIGIN", async () => {
    const keys = await makeVapidKeys();
    const jwt = await signVapidJwt(
      "https://fcm.googleapis.com",
      keys,
      1_700_000_000,
    );
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(decoder.decode(base64UrlToBytes(h!)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(decoder.decode(base64UrlToBytes(c!)));
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@metagraph.sh");
    expect(claims.exp).toBe(1_700_000_000 + 12 * 60 * 60);

    // Verify the signature against the advertised public key — proves the
    // raw r||s encoding is what JWS ES256 expects (not DER).
    const pub = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        pub,
        base64UrlToBytes(s!),
        encoder.encode(`${h}.${c}`),
      ),
    ).toBe(true);
  });

  it("audiences to the origin only, never the full endpoint path", () => {
    expect(pushAudience("https://fcm.googleapis.com/fcm/send/abc?x=1")).toBe(
      "https://fcm.googleapis.com",
    );
  });

  it("rejects non-https and malformed endpoints so a signed token can't be downgraded", () => {
    for (const bad of [
      "http://insecure.example/push",
      "not a url",
      "",
      "ftp://x/y",
    ]) {
      expect(pushAudience(bad)).toBeNull();
    }
  });

  it("builds a complete signed request with the RFC 8292 single-header form", async () => {
    const sub = await makeSubscriber();
    const keys = await makeVapidKeys();
    const req = await buildPushRequest("hello", sub.subscription, keys);
    expect(req).not.toBeNull();
    expect(req!.url).toBe(sub.subscription.endpoint);
    expect(req!.headers.authorization).toMatch(
      /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/,
    );
    expect(req!.headers["content-encoding"]).toBe("aes128gcm");
    expect(req!.headers["content-type"]).toBe("application/octet-stream");
    expect(req!.headers.urgency).toBe("normal");
    expect(await decryptAsBrowser(req!.body, sub)).toBe("hello");
  });

  it("returns null (not throw) for an unusable endpoint, so one bad device can't fail a batch", async () => {
    const sub = await makeSubscriber("http://insecure.example/push");
    const keys = await makeVapidKeys();
    expect(await buildPushRequest("hello", sub.subscription, keys)).toBeNull();
  });

  it("rejects a VAPID public key that isn't a 65-byte uncompressed point", async () => {
    const keys = await makeVapidKeys();
    await expect(
      signVapidJwt("https://x.example", {
        ...keys,
        publicKey: bytesToBase64Url(new Uint8Array(64)),
      }),
    ).rejects.toThrow(/uncompressed P-256 point/);
  });

  it("accepts real browser key material and rejects malformed shapes at intake", async () => {
    const sub = await makeSubscriber();
    expect(
      isValidPushKeyMaterial(sub.subscription.p256dh, sub.subscription.auth),
    ).toBe(true);

    const goodAuth = sub.subscription.auth;
    const goodKey = sub.subscription.p256dh;
    // Wrong lengths (RFC 8291 fixes both at 65 and 16 bytes).
    expect(
      isValidPushKeyMaterial(bytesToBase64Url(new Uint8Array(64)), goodAuth),
    ).toBe(false);
    expect(
      isValidPushKeyMaterial(goodKey, bytesToBase64Url(new Uint8Array(15))),
    ).toBe(false);
    // Not an uncompressed point (first byte must be 0x04).
    const compressed = new Uint8Array(65);
    compressed[0] = 0x02;
    expect(isValidPushKeyMaterial(bytesToBase64Url(compressed), goodAuth)).toBe(
      false,
    );
    // Outside the base64url alphabet, wrong types, empty.
    for (const bad of ["not+base64/url==", "", null, undefined, 42]) {
      expect(isValidPushKeyMaterial(bad, goodAuth)).toBe(false);
      expect(isValidPushKeyMaterial(goodKey, bad)).toBe(false);
    }
  });

  it("rejects key material whose length makes decoding throw", () => {
    // A single base64url character passes the alphabet regex but pads to
    // "A===", which atob rejects outright — so the decode guard is a real
    // path, not dead defensive code. Verified against atob directly.
    expect(isValidPushKeyMaterial("A", "A")).toBe(false);
  });

  it("treats only 404/410 as a permanently expired subscription", () => {
    expect(isExpiredSubscriptionStatus(404)).toBe(true);
    expect(isExpiredSubscriptionStatus(410)).toBe(true);
    // Transient — must stay in the retry path, not be pruned.
    for (const status of [200, 201, 400, 401, 429, 500, 502, 503]) {
      expect(isExpiredSubscriptionStatus(status)).toBe(false);
    }
  });

  it("round-trips base64url without padding, including URL-unsafe bytes", () => {
    const bytes = new Uint8Array([251, 255, 190, 0, 62, 63]);
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });
});
