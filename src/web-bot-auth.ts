// Web Bot Auth: the prober fleet signs what it sends (#11146 readiness row,
// repo half of metagraphed-infra#562).
//
// ## WHY A PROBER SIGNS
//
// The fleet probes ~600 third-party subnet surfaces every 15 minutes, and to
// every one of them an unsigned probe is indistinguishable from a scraper. As
// subnets put up bot-management walls, unsigned probes start eating 403s --
// which does not fail loudly, it QUIETLY DEGRADES the health data that is this
// registry's core product: a blocked probe scores as a dead surface. Signing
// per the IETF web-bot-auth draft (RFC 9421 HTTP Message Signatures, Ed25519)
// lets any origin verify "this is metagraphed's prober" cryptographically and
// allowlist the fleet, instead of trusting a User-Agent string anyone can
// fake.
//
// ## THE SHAPE, PER THE DRAFT
//
// Three headers ride each signed request:
//   Signature-Input  the signed components + parameters (created, expires,
//                    keyid, tag, nonce), per RFC 9421
//   Signature        the Ed25519 signature over the signature base
//   Signature-Agent  where the verifier fetches our key directory
//
// The signed component set is `("@authority")` -- the minimum the draft
// requires and deliberately nothing more: the authority binds the signature to
// the destination host (a signature replayed against another host fails), and
// signing paths or bodies would couple the signature to probe mechanics that
// change. `keyid` is the base64url JWK thumbprint (RFC 7638) of the public
// key, which is also how the directory names it, so verifier and directory
// agree by construction.
//
// ## GATED ON THE SECRET, ABSENT MEANS TODAY
//
// Everything keys off METAGRAPH_BOT_SIGNING_KEY, formatted `<seed>.<public>`:
// two base64url-encoded 32-byte halves, dot-separated. Both halves ride the
// secret because WebCrypto cannot derive an Ed25519 public key from a seed,
// and the directory must publish exactly the key the signatures verify
// against. No secret -> no signing, no directory, no behaviour change: local
// dev, CI and the determinism suite never see a signature. A malformed secret
// DISABLES signing rather than failing probes -- an unsigned probe still
// probes, and the signature must never be the reason health data stops.
//
// ## WHY THE KEY IS CACHED PER ISOLATE
//
// crypto.subtle.importKey is cheap but not free, and the prober signs ~600
// requests per sweep. The imported CryptoKey and thumbprint are cached keyed
// by the secret VALUE, so a rotated secret takes effect on the next isolate
// without a deploy, and a changed value is never served stale.

type Row = Record<string, unknown>;

/** Where verifiers fetch our JWKS, on the primary host. The draft requires the
 * directory response itself to be signed; the handler below does that. */
export { BOT_KEY_DIRECTORY_PATH } from "./web-bot-auth-paths.ts";
import { registerModuleStateReset } from "./module-state-registry.ts";
export const BOT_KEY_DIRECTORY_CONTENT_TYPE =
  "application/http-message-signatures-directory+json";

/** The draft's tag for web-bot-auth signatures. */
const SIGNATURE_TAG = "web-bot-auth";

/** Signatures outlive transit, not much more: the draft's own guidance is
 * that "a minute is often sufficient". */
const SIGNATURE_TTL_SECONDS = 120;

export interface BotSigner {
  /** Adds Signature-Input / Signature / Signature-Agent for `url`'s authority. */
  sign(url: string, headers: Headers): Promise<void>;
  /** The public JWK, for the directory. */
  publicJwk: Row;
  thumbprint: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64Encode(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw);
}

function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** RFC 7638 JWK thumbprint for an OKP key: SHA-256 over the canonical
 * `{"crv","kty","x"}` member set, base64url -- the value web-bot-auth uses as
 * `keyid`, so the verifier finds the directory entry by construction. */
async function jwkThumbprint(jwk: Row): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

interface SignerCacheEntry {
  secret: string;
  signer: BotSigner | null;
}
let signerCache: SignerCacheEntry | null = null;
// The house reset (validate:module-state-resets): under `isolate: false` a
// cached signer would leak across test files, and a file that never set a
// secret would inherit one.
registerModuleStateReset("src/web-bot-auth.ts", () => {
  signerCache = null;
});

/** Test seam: clears the per-isolate signer cache. */
export function resetBotSignerForTests(): void {
  signerCache = null;
}

/**
 * The signer for this deployment, or null when signing is off.
 *
 * Null on: no secret (the normal local/CI state), a secret that is not
 * `<seed>.<public>` with 32-byte halves, or a WebCrypto that refuses Ed25519.
 * Every arm is a deliberate "probe unsigned" rather than a throw -- see the
 * module header.
 */
export async function botSignerFromEnv(env: {
  METAGRAPH_BOT_SIGNING_KEY?: string;
}): Promise<BotSigner | null> {
  const secret = env?.METAGRAPH_BOT_SIGNING_KEY;
  if (!secret) return null;
  if (signerCache?.secret === secret) return signerCache.signer;
  const signer = await buildSigner(secret);
  signerCache = { secret, signer };
  return signer;
}

// PKCS#8 DER header for an Ed25519 (OID 1.3.101.112) private key: WebCrypto
// imports private keys as pkcs8, and prepending this to the raw 32-byte seed
// is the standard wrapping.
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04,
  0x22, 0x04, 0x20,
]);

async function buildSigner(secret: string): Promise<BotSigner | null> {
  const [seedPart, publicPart, ...extra] = secret.split(".");
  if (extra.length > 0 || !seedPart || !publicPart) return null;
  const seed = base64UrlDecode(seedPart);
  const publicRaw = base64UrlDecode(publicPart);
  if (!seed || seed.length !== 32 || !publicRaw || publicRaw.length !== 32) {
    return null;
  }
  let privateKey: CryptoKey;
  try {
    const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
    pkcs8.set(ED25519_PKCS8_PREFIX);
    pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
  } catch {
    return null;
  }
  const publicJwk: Row = {
    kty: "OKP",
    crv: "Ed25519",
    x: base64UrlEncode(publicRaw),
    use: "sig",
  };
  const thumbprint = await jwkThumbprint(publicJwk);

  const sign = async (url: string, headers: Headers): Promise<void> => {
    let authority: string;
    try {
      authority = new URL(url).host;
    } catch {
      // Not a URL the platform can parse; the probe itself will fail on it,
      // and an unsigned attempt keeps the failure attributable to the probe.
      return;
    }
    const created = Math.floor(Date.now() / 1000);
    const expires = created + SIGNATURE_TTL_SECONDS;
    const nonce = crypto.randomUUID();
    // RFC 9421 signature params, in the order the draft's examples use.
    const params =
      `("@authority");created=${created};expires=${expires};` +
      `keyid="${thumbprint}";tag="${SIGNATURE_TAG}";nonce="${nonce}"`;
    const signatureBase =
      `"@authority": ${authority}\n` + `"@signature-params": ${params}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        new TextEncoder().encode(signatureBase),
      ),
    );
    headers.set("signature-input", `sig1=${params}`);
    headers.set("signature", `sig1=:${base64Encode(signature)}:`);
    // Structured-field string: the origin verifiers fetch the directory from.
    headers.set("signature-agent", `"https://api.metagraph.sh"`);
  };

  return { sign, publicJwk, thumbprint };
}

/**
 * GET /.well-known/http-message-signatures-directory -- the JWKS verifiers
 * fetch, itself signed with the key it publishes (the draft requires the
 * directory response to demonstrate possession).
 *
 * 404 when signing is off: an empty directory would say "we sign with no
 * keys", and absence is the truthful shape for a deployment with no key.
 */
export async function botKeyDirectoryResponse(
  request: Request,
  env: { METAGRAPH_BOT_SIGNING_KEY?: string },
): Promise<Response> {
  const signer = await botSignerFromEnv(env);
  if (!signer) {
    return new Response("no signing key configured", { status: 404 });
  }
  const body = `${JSON.stringify({ keys: [signer.publicJwk] }, null, 2)}\n`;
  const headers = new Headers({
    "content-type": BOT_KEY_DIRECTORY_CONTENT_TYPE,
    "cache-control": "public, max-age=86400",
  });
  await signer.sign(request.url, headers);
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
