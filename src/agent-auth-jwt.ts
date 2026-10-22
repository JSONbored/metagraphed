// Service-owned Auth.md assertions. These are reusable RFC 7523 grants until
// their fixed approval window closes; registration revocation is checked by
// the caller on every exchange, separately from this signature verification.
// The key is dedicated to this protocol, never a wallet or prober key.

import { registerModuleStateReset } from "./module-state-registry.ts";

export const AGENT_AUTH_ASSERTION_TTL_SECONDS = 3600;

export interface AgentAuthAssertion {
  registrationId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AgentAuthSigner {
  sign(
    registrationId: string,
    issuedAt: number,
    expiresAt: number,
  ): Promise<string>;
  verify(
    assertion: string,
    nowSeconds: number,
  ): Promise<AgentAuthAssertion | null>;
  jwks(): { keys: JsonWebKey[] };
}

type JsonObject = Record<string, unknown>;
type PublicJwk = JsonWebKey & { kid: string };

const ALG = "ES256";
const TYP = "oauth-id-jag+jwt";
const MAX_SECRET_LENGTH = 4096;
const MAX_ASSERTION_LENGTH = 8192;
const MAX_HEADER_BYTES = 512;
const MAX_CLAIMS_BYTES = 4096;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

let signerCache:
  | {
      secret: string | undefined;
      issuer: string;
      signer: Promise<AgentAuthSigner | null>;
    }
  | undefined;
registerModuleStateReset("src/agent-auth-jwt.ts", () => {
  signerCache = undefined;
});

/** Coalesce key validation in one isolate, replacing it on any config change. */
export async function loadCachedAgentAuthSigner(
  secret: string | undefined,
  issuer: string,
): Promise<AgentAuthSigner | null> {
  if (
    signerCache &&
    signerCache.secret === secret &&
    signerCache.issuer === issuer
  )
    return signerCache.signer;
  const entry = { secret, issuer, signer: loadAgentAuthSigner(secret, issuer) };
  signerCache = entry;
  const signer = await entry.signer;
  // A transient crypto failure is retried. An older failed load cannot evict
  // the signer installed by a newer request after a configuration change.
  if (!signer && signerCache === entry) signerCache = undefined;
  return signer;
}

function encode(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// A canonical base64url spelling prevents padded/alternate encodings from
// introducing different bearer strings for the same assertion or JWK member.
function decode(value: string, maxBytes: number): Uint8Array | null {
  if (
    value.length > Math.ceil((maxBytes * 4) / 3) ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return null;
  }
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (value.length % 4)) % 4),
  );
  const bytes = Uint8Array.from(raw, (byte) => byte.charCodeAt(0));
  return encode(bytes) === value ? bytes : null;
}

function objectFrom(text: string): JsonObject | null {
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validTimes(issuedAt: unknown, expiresAt: unknown): boolean {
  return (
    Number.isSafeInteger(issuedAt) &&
    Number.isSafeInteger(expiresAt) &&
    (issuedAt as number) > 0 &&
    (expiresAt as number) > (issuedAt as number) &&
    (expiresAt as number) - (issuedAt as number) <=
      AGENT_AUTH_ASSERTION_TTL_SECONDS
  );
}

function validKeyMember(value: unknown): value is string {
  return typeof value === "string" && decode(value, 32)?.length === 32;
}

/**
 * Load AUTHMD_SIGNING_JWK. Missing/invalid configuration disables the flow;
 * neither the secret nor crypto diagnostics are included in errors or logs.
 * No generated key is persisted here: infra must provision a stable key so
 * assertions survive Worker/isolate replacement.
 */
export async function loadAgentAuthSigner(
  secret: string | undefined,
  issuer: string,
): Promise<AgentAuthSigner | null> {
  if (!secret || secret.length > MAX_SECRET_LENGTH) return null;
  try {
    const issuerUrl = new URL(issuer);
    if (issuerUrl.protocol !== "https:" || issuerUrl.origin !== issuer) {
      return null;
    }
    const jwk = objectFrom(secret);
    if (
      !jwk ||
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      !validKeyMember(jwk.x) ||
      !validKeyMember(jwk.y) ||
      !validKeyMember(jwk.d) ||
      (jwk.alg !== undefined && jwk.alg !== ALG) ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.ext !== undefined && typeof jwk.ext !== "boolean") ||
      (jwk.key_ops !== undefined &&
        (!Array.isArray(jwk.key_ops) ||
          jwk.key_ops.length !== 1 ||
          jwk.key_ops[0] !== "sign"))
    ) {
      return null;
    }
    const thumbprint = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }),
      ),
    );
    const kid = encode(new Uint8Array(thumbprint));
    if (jwk.kid !== undefined && jwk.kid !== kid) return null;
    const publicJwk: PublicJwk = {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      alg: ALG,
      use: "sig",
      key_ops: ["verify"],
      kid,
    };
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk, d: jwk.d, key_ops: ["sign"], ext: false },
      KEY_ALGORITHM,
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      KEY_ALGORITHM,
      false,
      ["verify"],
    );
    // Importers differ in whether they validate a private JWK's public half.
    // Prove the two halves form a pair before publishing a key or accepting
    // traffic; a mismatched deployment key must fail closed.
    const challenge = encoder.encode("metagraphed Auth.md signing-key check");
    const proof = await crypto.subtle.sign(
      SIGN_ALGORITHM,
      privateKey,
      challenge,
    );
    if (
      !(await crypto.subtle.verify(SIGN_ALGORITHM, publicKey, proof, challenge))
    ) {
      return null;
    }

    return {
      async sign(registrationId, issuedAt, expiresAt) {
        if (!validId(registrationId) || !validTimes(issuedAt, expiresAt)) {
          throw new Error("Invalid agent assertion claims");
        }
        const header = encode(
          encoder.encode(JSON.stringify({ alg: ALG, typ: TYP, kid })),
        );
        const claims = encode(
          encoder.encode(
            JSON.stringify({
              iss: issuer,
              aud: issuer,
              sub: registrationId,
              jti: `jti_${crypto.randomUUID()}`,
              iat: issuedAt,
              exp: expiresAt,
            }),
          ),
        );
        const input = `${header}.${claims}`;
        const signature = await crypto.subtle.sign(
          SIGN_ALGORITHM,
          privateKey,
          encoder.encode(input),
        );
        return `${input}.${encode(new Uint8Array(signature))}`;
      },
      async verify(assertion, nowSeconds) {
        if (
          typeof assertion !== "string" ||
          assertion.length > MAX_ASSERTION_LENGTH ||
          !Number.isSafeInteger(nowSeconds) ||
          nowSeconds < 0
        ) {
          return null;
        }
        try {
          const parts = assertion.split(".");
          if (parts.length !== 3) return null;
          const headerBytes = decode(parts[0], MAX_HEADER_BYTES);
          const claimsBytes = decode(parts[1], MAX_CLAIMS_BYTES);
          const signature = decode(parts[2], 64);
          if (!headerBytes || !claimsBytes || signature?.length !== 64) {
            return null;
          }
          const header = objectFrom(decoder.decode(headerBytes));
          const claims = objectFrom(decoder.decode(claimsBytes));
          if (
            !header ||
            header.alg !== ALG ||
            header.typ !== TYP ||
            header.kid !== kid ||
            Object.keys(header).some(
              (key) => !["alg", "typ", "kid"].includes(key),
            ) ||
            !claims ||
            claims.iss !== issuer ||
            claims.aud !== issuer ||
            !validId(claims.sub) ||
            !validId(claims.jti) ||
            !validTimes(claims.iat, claims.exp) ||
            (claims.iat as number) > nowSeconds ||
            (claims.exp as number) <= nowSeconds
          ) {
            return null;
          }
          const accepted = await crypto.subtle.verify(
            SIGN_ALGORITHM,
            publicKey,
            signature,
            encoder.encode(`${parts[0]}.${parts[1]}`),
          );
          return accepted
            ? {
                registrationId: claims.sub,
                issuedAt: claims.iat as number,
                expiresAt: claims.exp as number,
              }
            : null;
        } catch {
          return null;
        }
      },
      // Return copies: callers cannot change the key used by this signer or
      // accidentally add a private member to a future directory response.
      jwks: () => ({ keys: [{ ...publicJwk, key_ops: ["verify"] }] }),
    };
  } catch {
    return null;
  }
}
