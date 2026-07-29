// Web Push sender primitives (#8385): VAPID request signing (RFC 8292) and
// aes128gcm payload encryption (RFC 8291), implemented on WebCrypto so they
// run unchanged in a Cloudflare Worker.
//
// Deliberately dependency-free. The usual npm option (`web-push`) is a Node
// library that reaches for `crypto`/`https` and is not Worker-safe, and this
// module is ~200 lines of well-specified crypto — vendoring a Node shim to
// avoid writing it would trade a small, reviewable, testable surface for a
// large unreviewable one on the delivery path.
//
// Everything here is PURE with respect to the network: `buildPushRequest`
// returns the URL/headers/body that a caller then `fetch`es. That keeps the
// crypto unit-testable without a push service (and without live VAPID keys),
// which matters because the real endpoints can only be exercised at deploy
// time — see the deploy prerequisites in this feature's PR.
//
// SECURITY / PRIVACY NOTE: the push service (Mozilla/Google/Apple) is an
// untrusted relay. It sees the endpoint and the ciphertext, never the
// plaintext — payload encryption is end-to-end between this Worker and the
// subscriber's browser, keyed by material only they hold (`p256dh` + `auth`).
// That is why a payload is encrypted rather than sent as plain JSON.

/** A browser PushSubscription's server-relevant fields, as posted by the UI. */
export interface PushSubscriptionKeys {
  /** The push service URL the browser handed us. Origin identifies the service. */
  endpoint: string;
  /** UA public key, P-256 uncompressed point (65 bytes), base64url. */
  p256dh: string;
  /** UA auth secret (16 bytes), base64url. */
  auth: string;
}

/** VAPID identity. Values come from Worker secrets — never the repo. */
export interface VapidKeys {
  /** P-256 public key, uncompressed point (65 bytes), base64url. */
  publicKey: string;
  /** P-256 signing scalar (32 bytes), base64url. The secret half — supplied
   * from a Worker secret, never stored or logged. */
  signingKey: string;
  /** `mailto:` or `https:` contact, per RFC 8292 §2.1. */
  subject: string;
}

export interface PushRequest {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

// RFC 8291 §4: the only record size we emit. One record is always enough --
// MAX_PAYLOAD_BYTES below is far under this, so there is no multi-record path
// to get wrong.
const RECORD_SIZE = 4096;

/**
 * Payload ceiling (#8385 requirement 3: "Payload ≤2KB").
 *
 * Push services commonly cap a request body at 4096 bytes, and encryption
 * adds a fixed 103-byte header (16 salt + 4 rs + 1 idlen + 65 key + 16 GCM
 * tag + 1 delimiter). 2 KB of plaintext leaves generous headroom, so a long
 * entity name can never push a notification over a service's limit.
 */
export const MAX_PAYLOAD_BYTES = 2048;

/** Default JWT lifetime. RFC 8292 §2 caps `exp` at 24h from issuance; 12h
 * leaves room for clock skew on either side without re-signing per send. */
export const VAPID_TTL_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * The push service origin a VAPID JWT is audienced to (RFC 8292 §2: `aud` is
 * the service's origin, NOT the full endpoint). Returns null for a
 * non-absolute or non-https endpoint so a malformed subscription can never
 * produce a request aimed somewhere unintended.
 */
export function pushAudience(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // https only: a push endpoint is always TLS, and allowing http would let a
  // stored subscription downgrade a signed credential onto the wire.
  if (url.protocol !== "https:") return null;
  return url.origin;
}

/** HKDF (RFC 5869) over WebCrypto, returning `length` bytes. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** `Content-Encoding: <label>\0` info strings, per RFC 8188 §2.1. */
function contentEncodingInfo(label: string): Uint8Array {
  return encoder.encode(`Content-Encoding: ${label}\0`);
}

/**
 * Encrypt a payload for one subscription (RFC 8291 aes128gcm).
 *
 * Layout of the returned body, per RFC 8188 §2.1:
 *   salt(16) | rs(4, big-endian) | idlen(1)=65 | as_public(65) | ciphertext
 * where the plaintext has a single 0x02 delimiter appended marking it as the
 * last record.
 *
 * `salt` and `serverKeys` are injectable ONLY so tests can pin a known
 * vector; production always passes neither and gets fresh random material,
 * which is required — reusing a salt/ephemeral key across sends would leak
 * plaintext relationships.
 */
export async function encryptPushPayload(
  payload: string,
  subscription: PushSubscriptionKeys,
  overrides?: { salt?: Uint8Array; serverKeys?: CryptoKeyPair },
): Promise<Uint8Array> {
  const plaintext = encoder.encode(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `push payload ${plaintext.length}B exceeds ${MAX_PAYLOAD_BYTES}B`,
    );
  }

  const uaPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);

  const serverKeys =
    overrides?.serverKeys ??
    ((await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair);
  // Workers' typings widen exportKey to ArrayBuffer | JsonWebKey; "raw"
  // always yields the ArrayBuffer arm.
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", serverKeys.publicKey)) as ArrayBuffer,
  );

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Cast: Cloudflare's typings name this member `$public`, while the
      // runtime (and the WebCrypto spec) use `public`.
      { name: "ECDH", public: uaKey } as unknown as Parameters<
        SubtleCrypto["deriveBits"]
      >[0],
      serverKeys.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3: the IKM binds both parties' public keys, so a shared
  // secret alone is not enough to derive the key -- this is what stops a
  // relay that observed one exchange from replaying into another.
  const prkInfo = concatBytes(
    encoder.encode("WebPush: info\0"),
    uaPublic,
    asPublic,
  );
  const ikm = await hkdf(authSecret, sharedSecret, prkInfo, 32);

  const salt = overrides?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, contentEncodingInfo("aes128gcm"), 16);
  const nonce = await hkdf(salt, ikm, contentEncodingInfo("nonce"), 12);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  // 0x02 = last-record delimiter (RFC 8188 §2). A 0x01 here would tell the
  // browser more records follow and it would fail to decode.
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      padded as BufferSource,
    ),
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE, false);
  return concatBytes(
    salt,
    rs,
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext,
  );
}

/** Import a raw base64url P-256 private scalar as an ECDSA signing key. */
async function importVapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicBytes = base64UrlToBytes(keys.publicKey);
  // Uncompressed point: 0x04 || X(32) || Y(32).
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error(
      "VAPID public key must be a 65-byte uncompressed P-256 point",
    );
  }
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicBytes.slice(1, 33)),
    y: bytesToBase64Url(publicBytes.slice(33, 65)),
    d: keys.signingKey,
    ext: true,
  };
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Sign a VAPID JWT for one push-service audience (RFC 8292 §2).
 *
 * WebCrypto's ECDSA output is already the raw r||s pair JWS ES256 requires,
 * so no DER unwrapping is needed (a common source of bugs when porting from
 * Node's crypto, which returns DER).
 */
export async function signVapidJwt(
  audience: string,
  keys: VapidKeys,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = bytesToBase64Url(
    encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = bytesToBase64Url(
    encoder.encode(
      JSON.stringify({
        aud: audience,
        exp: nowSeconds + VAPID_TTL_SECONDS,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await importVapidSigningKey(keys),
      encoder.encode(signingInput) as BufferSource,
    ),
  );
  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

/**
 * Build the complete signed, encrypted push request for one subscription.
 *
 * Returns null (never throws) when the endpoint isn't a usable https URL, so
 * a single malformed stored subscription degrades to "skip this device"
 * rather than failing a whole delivery batch.
 */
export async function buildPushRequest(
  payload: string,
  subscription: PushSubscriptionKeys,
  keys: VapidKeys,
  options?: {
    ttlSeconds?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
  },
): Promise<PushRequest | null> {
  const audience = pushAudience(subscription.endpoint);
  if (!audience) return null;

  const body = await encryptPushPayload(payload, subscription);
  const jwt = await signVapidJwt(audience, keys);

  return {
    url: subscription.endpoint,
    headers: {
      // RFC 8292 §3.1 single-header form.
      authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      // How long the service may queue for an offline device.
      ttl: String(options?.ttlSeconds ?? 60 * 60 * 24),
      urgency: options?.urgency ?? "normal",
    },
    body,
  };
}

/**
 * Shape-check a subscription's key material at INTAKE, so a malformed device
 * fails once at subscribe time rather than silently on every future delivery.
 *
 * `p256dh` must decode to a 65-byte uncompressed P-256 point (0x04 || X || Y)
 * and `auth` to a 16-byte secret — both fixed by RFC 8291. This is a shape
 * check, not a validity proof: only an actual ECDH derive can prove the point
 * is on the curve, and that happens at send time.
 */
export function isValidPushKeyMaterial(
  p256dh: unknown,
  auth: unknown,
): boolean {
  if (typeof p256dh !== "string" || typeof auth !== "string") return false;
  // Reject anything outside the base64url alphabet before decoding: atob is
  // lenient about some inputs, and a stored value that only *sometimes*
  // decodes is worse than one rejected up front.
  const base64Url = /^[A-Za-z0-9_-]+$/;
  if (!base64Url.test(p256dh) || !base64Url.test(auth)) return false;
  try {
    const key = base64UrlToBytes(p256dh);
    const secret = base64UrlToBytes(auth);
    return key.length === 65 && key[0] === 0x04 && secret.length === 16;
  } catch {
    return false;
  }
}

/**
 * Whether a push-service response means the subscription is permanently gone
 * (#8385 requirement 4).
 *
 * 404 = endpoint never existed / was purged; 410 Gone = the browser
 * unsubscribed. Both are terminal, so the row should be pruned rather than
 * retried — retrying a 410 forever is the classic web-push storage leak.
 * Every other status (including 429 and 5xx) is transient and left to the
 * caller's existing retry/backoff.
 */
export function isExpiredSubscriptionStatus(status: number): boolean {
  return status === 404 || status === 410;
}
