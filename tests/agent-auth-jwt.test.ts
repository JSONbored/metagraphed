import assert from "node:assert/strict";
import { beforeAll, describe, test, vi } from "vitest";
import {
  AGENT_AUTH_ASSERTION_TTL_SECONDS,
  loadCachedAgentAuthSigner,
  loadAgentAuthSigner,
  type AgentAuthSigner,
} from "../src/agent-auth-jwt.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

const ISSUER = "https://api.metagraph.sh";
const NOW = 1_790_000_000;
const ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;
const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const encoder = new TextEncoder();
type ObjectValue = Record<string, unknown>;
type PublicJwk = JsonWebKey & { kid: string };

let pair: CryptoKeyPair;
let otherPair: CryptoKeyPair;
let privateJwk: JsonWebKey;
let secret: string;
let signer: AgentAuthSigner;
let header: ObjectValue;
const claims: ObjectValue = {
  iss: ISSUER,
  aud: ISSUER,
  sub: "reg_owner_123",
  jti: "jti_unique_123",
  iat: NOW,
  exp: NOW + AGENT_AUTH_ASSERTION_TTL_SECONDS,
};

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function encodedJson(value: unknown): string {
  return encode(encoder.encode(JSON.stringify(value)));
}

function decodedJson(value: string): ObjectValue {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

// Construct assertions independently of the implementation under test so a
// signer/verifier bug cannot make a broken protocol pass its own round trip.
async function signParts(
  headerPart: string,
  claimsPart: string,
  signingKey = pair.privateKey,
): Promise<string> {
  const input = `${headerPart}.${claimsPart}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    signingKey,
    encoder.encode(input),
  );
  return `${input}.${encode(new Uint8Array(signature))}`;
}

async function mint(
  headerValue: unknown = header,
  claimsValue: unknown = claims,
  signingKey = pair.privateKey,
): Promise<string> {
  return signParts(
    encodedJson(headerValue),
    encodedJson(claimsValue),
    signingKey,
  );
}

function changedSecret(changes: ObjectValue): string {
  return JSON.stringify({ ...privateJwk, ...changes });
}

beforeAll(async () => {
  pair = (await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  otherPair = (await crypto.subtle.generateKey(KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  secret = JSON.stringify(privateJwk);
  const loaded = await loadAgentAuthSigner(secret, ISSUER);
  assert.ok(loaded);
  signer = loaded;
  const publicJwk = signer.jwks().keys[0] as JsonWebKey & { kid: string };
  header = { alg: "ES256", typ: "oauth-id-jag+jwt", kid: publicJwk.kid };
});

describe("bounded signing-key cache", () => {
  test("coalesces concurrent imports and releases its state on reset", async () => {
    resetModuleState();
    const imports = vi.spyOn(crypto.subtle, "importKey");
    try {
      const [first, second] = await Promise.all([
        loadCachedAgentAuthSigner(secret, ISSUER),
        loadCachedAgentAuthSigner(secret, ISSUER),
      ]);
      assert.ok(first);
      assert.equal(second, first);
      assert.equal(await loadCachedAgentAuthSigner(secret, ISSUER), first);
      assert.equal(imports.mock.calls.length, 2);
      resetModuleState();
      const reloaded = await loadCachedAgentAuthSigner(secret, ISSUER);
      assert.ok(reloaded);
      assert.notEqual(reloaded, first);
      assert.equal(imports.mock.calls.length, 4);
    } finally {
      imports.mockRestore();
      resetModuleState();
    }
  });

  test("a changed key or issuer replaces the single retained entry", async () => {
    resetModuleState();
    const first = await loadCachedAgentAuthSigner(secret, ISSUER);
    assert.ok(first);
    const otherSecret = JSON.stringify(
      await crypto.subtle.exportKey("jwk", otherPair.privateKey),
    );
    const rotated = await loadCachedAgentAuthSigner(otherSecret, ISSUER);
    assert.ok(rotated);
    assert.notEqual(
      (rotated.jwks().keys[0] as PublicJwk).kid,
      (first.jwks().keys[0] as PublicJwk).kid,
    );
    assert.equal(
      await rotated.verify(
        await first.sign("registration", NOW, NOW + 60),
        NOW,
      ),
      null,
    );
    const returned = await loadCachedAgentAuthSigner(secret, ISSUER);
    assert.ok(returned);
    assert.notEqual(returned, first);
    const otherIssuer = await loadCachedAgentAuthSigner(
      secret,
      "https://other.example.com",
    );
    assert.ok(otherIssuer);
    assert.notEqual(otherIssuer, returned);
    assert.equal(
      await otherIssuer.verify(
        await returned.sign("registration", NOW, NOW + 60),
        NOW,
      ),
      null,
    );
    resetModuleState();
  });

  test("removed or invalid configuration immediately discards the prior key", async () => {
    resetModuleState();
    assert.equal(await loadCachedAgentAuthSigner(undefined, ISSUER), null);
    for (const invalid of [undefined, "not json", "x".repeat(4097)]) {
      const prior = await loadCachedAgentAuthSigner(secret, ISSUER);
      assert.ok(prior);
      assert.equal(await loadCachedAgentAuthSigner(invalid, ISSUER), null);
      const restored = await loadCachedAgentAuthSigner(secret, ISSUER);
      assert.ok(restored);
      assert.notEqual(restored, prior);
    }
    assert.equal(
      await loadCachedAgentAuthSigner(secret, "http://other.example.com"),
      null,
    );
    resetModuleState();
  });

  test("a transient key import failure retries without a configuration change", async () => {
    resetModuleState();
    const imports = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("temporary failure"));
    try {
      assert.equal(await loadCachedAgentAuthSigner(secret, ISSUER), null);
      assert.ok(await loadCachedAgentAuthSigner(secret, ISSUER));
      assert.equal(imports.mock.calls.length, 3);
    } finally {
      imports.mockRestore();
      resetModuleState();
    }
  });

  test("a delayed failure for an old key cannot clear the newer key", async () => {
    resetModuleState();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementationOnce(async () => {
        await gate;
        throw new Error("old key validation failed");
      });
    try {
      const stale = loadCachedAgentAuthSigner(secret, ISSUER);
      const otherSecret = JSON.stringify(
        await crypto.subtle.exportKey("jwk", otherPair.privateKey),
      );
      const current = await loadCachedAgentAuthSigner(otherSecret, ISSUER);
      assert.ok(current);
      release();
      assert.equal(await stale, null);
      assert.equal(
        await loadCachedAgentAuthSigner(otherSecret, ISSUER),
        current,
      );
    } finally {
      release();
      digest.mockRestore();
      resetModuleState();
    }
  });
});

describe("dedicated service signing key", () => {
  test("missing, oversized and invalid configuration fails closed", async () => {
    for (const value of [
      undefined,
      "",
      "x".repeat(4097),
      "not json",
      "null",
      "[]",
      "true",
      "42",
      '"a string"',
      "{}",
    ]) {
      assert.equal(await loadAgentAuthSigner(value, ISSUER), null);
    }
  });

  test("issuer must be its canonical HTTPS origin", async () => {
    for (const issuer of [
      "not a URL",
      "http://api.metagraph.sh",
      `${ISSUER}/`,
      `${ISSUER}/auth`,
      `${ISSUER}?other=issuer`,
      `${ISSUER}#fragment`,
      "https://user:password@api.metagraph.sh",
      "https://API.metagraph.sh",
      "https://api.metagraph.sh:443",
    ]) {
      assert.equal(await loadAgentAuthSigner(secret, issuer), null);
    }
  });

  test("only an EC P-256 signature key with signing permissions is accepted", async () => {
    for (const changes of [
      { kty: "RSA" },
      { crv: "P-384" },
      { alg: "HS256" },
      { use: "enc" },
      { ext: "true" },
      { key_ops: "sign" },
      { key_ops: [] },
      { key_ops: ["sign", "verify"] },
      { key_ops: ["verify"] },
      { kid: "unrelated-key" },
      { kid: 1 },
    ]) {
      assert.equal(
        await loadAgentAuthSigner(changedSecret(changes), ISSUER),
        null,
      );
    }
  });

  test("all coordinates and the scalar require canonical 32-byte base64url", async () => {
    for (const member of ["x", "y", "d"]) {
      for (const value of [
        undefined,
        null,
        1,
        "",
        "!!!",
        "A", // Valid alphabet, impossible base64 length.
        encode(new Uint8Array(31)),
        encode(new Uint8Array(33)),
        `${encode(new Uint8Array(32)).slice(0, -1)}B`, // Nonzero pad bits.
      ]) {
        assert.equal(
          await loadAgentAuthSigner(changedSecret({ [member]: value }), ISSUER),
          null,
          member,
        );
      }
    }
  });

  test("optional JWK metadata is checked and a public-only key is insufficient", async () => {
    const minimal = {
      kty: privateJwk.kty,
      crv: privateJwk.crv,
      x: privateJwk.x,
      y: privateJwk.y,
      d: privateJwk.d,
    };
    assert.ok(await loadAgentAuthSigner(JSON.stringify(minimal), ISSUER));
    const publicJwk = signer.jwks().keys[0];
    assert.equal(
      await loadAgentAuthSigner(JSON.stringify(publicJwk), ISSUER),
      null,
    );
    assert.ok(
      await loadAgentAuthSigner(
        JSON.stringify({
          ...minimal,
          alg: "ES256",
          use: "sig",
          ext: false,
          key_ops: ["sign"],
          kid: header.kid,
        }),
        ISSUER,
      ),
    );
  });

  test("a private key cannot publish a different public key", async () => {
    const other = await crypto.subtle.exportKey("jwk", otherPair.privateKey);
    assert.equal(
      await loadAgentAuthSigner(changedSecret({ d: other.d }), ISSUER),
      null,
    );
    const verify = vi
      .spyOn(crypto.subtle, "verify")
      .mockResolvedValueOnce(false);
    try {
      assert.equal(await loadAgentAuthSigner(secret, ISSUER), null);
    } finally {
      verify.mockRestore();
    }
  });

  test("crypto setup failures disable the flow without surfacing key material", async () => {
    const importKey = vi
      .spyOn(crypto.subtle, "importKey")
      .mockRejectedValueOnce(new Error("unsupported key"));
    try {
      assert.equal(await loadAgentAuthSigner(secret, ISSUER), null);
    } finally {
      importKey.mockRestore();
    }
    const sign = vi
      .spyOn(crypto.subtle, "sign")
      .mockRejectedValueOnce(new Error("signing unavailable"));
    try {
      assert.equal(await loadAgentAuthSigner(secret, ISSUER), null);
    } finally {
      sign.mockRestore();
    }
  });

  test("JWKS contains only the public key with its RFC 7638 thumbprint", async () => {
    const directory = signer.jwks();
    assert.equal(directory.keys.length, 1);
    const key = directory.keys[0] as JsonWebKey & { kid: string };
    const thumbprint = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(
        JSON.stringify({ crv: "P-256", kty: "EC", x: key.x, y: key.y }),
      ),
    );
    assert.equal(key.kid, encode(new Uint8Array(thumbprint)));
    assert.deepEqual(Object.keys(key).sort(), [
      "alg",
      "crv",
      "key_ops",
      "kid",
      "kty",
      "use",
      "x",
      "y",
    ]);
    assert.equal(key.d, undefined);
    assert.equal(key.alg, "ES256");
    assert.equal(key.use, "sig");
    assert.deepEqual(key.key_ops, ["verify"]);

    key.x = "changed";
    key.key_ops!.push("sign");
    directory.keys.push(privateJwk);
    assert.equal(signer.jwks().keys.length, 1);
    assert.equal(signer.jwks().keys[0].x, privateJwk.x);
    assert.deepEqual(signer.jwks().keys[0].key_ops, ["verify"]);
  });
});

describe("service assertion issuance", () => {
  test("an independent verifier accepts the published key and protocol claims", async () => {
    const token = await signer.sign("reg_owner_123", NOW, NOW + 3600);
    const parts = token.split(".");
    assert.deepEqual(decodedJson(parts[0]), header);
    const body = decodedJson(parts[1]);
    assert.equal(body.iss, ISSUER);
    assert.equal(body.aud, ISSUER);
    assert.equal(body.sub, "reg_owner_123");
    assert.equal(body.iat, NOW);
    assert.equal(body.exp, NOW + 3600);
    assert.match(body.jti as string, /^jti_[0-9a-f-]{36}$/);
    const key = await crypto.subtle.importKey(
      "jwk",
      signer.jwks().keys[0],
      KEY_ALGORITHM,
      false,
      ["verify"],
    );
    const signature = Buffer.from(parts[2], "base64url");
    assert.equal(signature.length, 64, "JOSE uses a raw r || s signature");
    assert.equal(
      await crypto.subtle.verify(
        ALGORITHM,
        key,
        signature,
        encoder.encode(`${parts[0]}.${parts[1]}`),
      ),
      true,
    );
    assert.deepEqual(await signer.verify(token, NOW), {
      registrationId: "reg_owner_123",
      issuedAt: NOW,
      expiresAt: NOW + 3600,
    });
  });

  test("separate assertions get separate jtis while sharing a fixed approval horizon", async () => {
    const first = await signer.sign("reg_owner_123", NOW, NOW + 3600);
    const second = await signer.sign("reg_owner_123", NOW, NOW + 3600);
    const firstClaims = decodedJson(first.split(".")[1]);
    const secondClaims = decodedJson(second.split(".")[1]);
    assert.notEqual(firstClaims.jti, secondClaims.jti);
    assert.equal(firstClaims.iat, secondClaims.iat);
    assert.equal(firstClaims.exp, secondClaims.exp);
    // Reusable service assertions are intentionally not one-use ID-JAGs.
    assert.deepEqual(
      await signer.verify(first, NOW + 1),
      await signer.verify(first, NOW + 2),
    );
  });

  test("invalid identifiers or approval windows are refused before signing", async () => {
    for (const registrationId of [
      "",
      "x".repeat(129),
      "reg/owner",
      "reg owner",
      "reg_é",
      1 as never,
    ]) {
      await assert.rejects(
        signer.sign(registrationId, NOW, NOW + 1),
        /Invalid agent assertion claims/,
      );
    }
    for (const [issuedAt, expiresAt] of [
      [Number.NaN, NOW + 1],
      [NOW, Number.NaN],
      [NOW + 0.5, NOW + 1],
      [NOW, NOW + 1.5],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
      [NOW, Number.POSITIVE_INFINITY],
      [0, 1],
      [-1, 1],
      [NOW, NOW],
      [NOW, NOW - 1],
      [NOW, NOW + 3601],
    ]) {
      await assert.rejects(signer.sign("reg_owner_123", issuedAt, expiresAt));
    }
    const short = await signer.sign("x".repeat(128), NOW, NOW + 1);
    assert.ok(await signer.verify(short, NOW));
  });
});

describe("assertion verification", () => {
  test("accepts independently signed reusable assertions only within their window", async () => {
    const token = await mint();
    const expected = {
      registrationId: "reg_owner_123",
      issuedAt: NOW,
      expiresAt: NOW + 3600,
    };
    assert.deepEqual(await signer.verify(token, NOW), expected);
    assert.deepEqual(await signer.verify(token, NOW + 3599), expected);
    assert.equal(await signer.verify(token, NOW - 1), null);
    assert.equal(await signer.verify(token, NOW + 3600), null);
    assert.equal(await signer.verify(token, NOW + 3601), null);
    for (const invalidNow of [
      -1,
      NOW + 0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.equal(await signer.verify(token, invalidNow), null);
    }
  });

  test("rejects unsupported or missing JOSE headers even with a valid signature", async () => {
    for (const [member, value] of [
      ["alg", undefined],
      ["alg", "none"],
      ["alg", "HS256"],
      ["typ", undefined],
      ["typ", "JWT"],
      ["kid", undefined],
      ["kid", "another-key"],
      ["crit", []],
      ["jku", "https://untrusted.example/keys"],
      ["b64", false],
    ] as const) {
      const token = await mint({ ...header, [member]: value });
      assert.equal(await signer.verify(token, NOW), null, member);
    }
    for (const bad of [null, [], "header", 1]) {
      assert.equal(await signer.verify(await mint(bad), NOW), null);
    }
  });

  test("requires exact issuer/audience and bounded registration and jti strings", async () => {
    for (const [member, value] of [
      ["iss", undefined],
      ["iss", "https://other.example"],
      ["iss", `${ISSUER}/`],
      ["aud", undefined],
      ["aud", "https://other.example"],
      ["aud", [ISSUER]],
      ["sub", undefined],
      ["sub", 1],
      ["sub", ""],
      ["sub", "a".repeat(129)],
      ["sub", "reg/owner"],
      ["jti", undefined],
      ["jti", 1],
      ["jti", ""],
      ["jti", "a".repeat(129)],
      ["jti", "jti with spaces"],
    ] as const) {
      assert.equal(
        await signer.verify(
          await mint(header, { ...claims, [member]: value }),
          NOW,
        ),
        null,
        member,
      );
    }
    for (const bad of [null, [], "claims", 1]) {
      assert.equal(await signer.verify(await mint(header, bad), NOW), null);
    }
  });

  test("requires integer issued/expiry times and at most a one-hour horizon", async () => {
    for (const [member, value] of [
      ["iat", undefined],
      ["iat", null],
      ["iat", `${NOW}`],
      ["iat", NOW + 0.5],
      ["iat", 0],
      ["iat", -1],
      ["iat", Number.MAX_SAFE_INTEGER + 1],
      ["exp", undefined],
      ["exp", `${NOW + 1}`],
      ["exp", NOW + 1.5],
      ["exp", Number.MAX_SAFE_INTEGER + 1],
      ["exp", NOW],
      ["exp", NOW - 1],
      ["exp", NOW + 3601],
    ] as const) {
      assert.equal(
        await signer.verify(
          await mint(header, { ...claims, [member]: value }),
          NOW,
        ),
        null,
        member,
      );
    }
  });

  test("cannot verify a different key, altered claims or an old rotated key", async () => {
    assert.equal(
      await signer.verify(
        await mint(header, claims, otherPair.privateKey),
        NOW,
      ),
      null,
    );
    const token = await mint();
    const parts = token.split(".");
    parts[1] = encodedJson({ ...claims, sub: "reg_other_owner" });
    assert.equal(await signer.verify(parts.join("."), NOW), null);

    const otherJwk = await crypto.subtle.exportKey("jwk", otherPair.privateKey);
    const rotated = await loadAgentAuthSigner(JSON.stringify(otherJwk), ISSUER);
    assert.ok(rotated);
    assert.equal(await rotated.verify(token, NOW), null);
    const newToken = await rotated.sign("reg_owner_123", NOW, NOW + 1);
    assert.equal(await signer.verify(newToken, NOW), null);
    assert.ok(await rotated.verify(newToken, NOW));
  });

  test("malformed, oversized and noncanonical compact encodings fail closed", async () => {
    const token = await mint();
    const parts = token.split(".");
    const signature63 = encode(new Uint8Array(63));
    const signature65 = encode(new Uint8Array(65));
    for (const bad of [
      null as never,
      undefined as never,
      1 as never,
      "",
      "one-part",
      "two.parts",
      `${token}.extra`,
      "x".repeat(8193),
      `.${parts[1]}.${parts[2]}`,
      `${parts[0]}..${parts[2]}`,
      `${parts[0]}.${parts[1]}.`,
      `!!!.${parts[1]}.${parts[2]}`,
      `${parts[0]}.!!!.${parts[2]}`,
      `${parts[0]}.${parts[1]}.!!!`,
      `A.${parts[1]}.${parts[2]}`,
      `${parts[0]}=.${parts[1]}.${parts[2]}`,
      `AB.${parts[1]}.${parts[2]}`, // Same decoded byte as AA, invalid pad bits.
      `${parts[0]}.${parts[1]}.${signature63}`,
      `${parts[0]}.${parts[1]}.${signature65}`,
      `${encode(new Uint8Array(513))}.${parts[1]}.${parts[2]}`,
      `${parts[0]}.${encode(new Uint8Array(4097))}.${parts[2]}`,
    ]) {
      assert.equal(await signer.verify(bad, NOW), null);
    }
  });

  test("invalid JSON and non-UTF8 bytes are rejected before claim interpretation", async () => {
    const validHeader = encodedJson(header);
    const validClaims = encodedJson(claims);
    const invalidJson = encode(encoder.encode("{invalid}"));
    const invalidUtf8 = encode(new Uint8Array([0xc0]));
    for (const [headerPart, claimsPart] of [
      [invalidJson, validClaims],
      [validHeader, invalidJson],
      [invalidUtf8, validClaims],
      [validHeader, invalidUtf8],
    ]) {
      assert.equal(
        await signer.verify(await signParts(headerPart, claimsPart), NOW),
        null,
      );
    }
  });

  test("verification backend failure returns no authenticated identity", async () => {
    const token = await mint();
    const verify = vi
      .spyOn(crypto.subtle, "verify")
      .mockRejectedValueOnce(new Error("verification unavailable"));
    try {
      assert.equal(await signer.verify(token, NOW), null);
    } finally {
      verify.mockRestore();
    }
  });
});
