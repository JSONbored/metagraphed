// Web Bot Auth (metagraphed-infra#562, repo half): the prober fleet's
// outbound signatures and the key directory verifiers fetch.
//
// The load-bearing test is the VERIFY round trip: a signature this module
// produces must verify with WebCrypto against the JWK the directory publishes,
// over the exact RFC 9421 signature base a verifier reconstructs -- otherwise
// the whole feature is three headers of noise.
import assert from "node:assert/strict";
import { beforeEach, describe, test, vi } from "vitest";
import {
  botKeyDirectoryResponse,
  botSignerFromEnv,
  resetBotSignerForTests,
  BOT_KEY_DIRECTORY_CONTENT_TYPE,
  BOT_KEY_DIRECTORY_PATH,
} from "../src/web-bot-auth.ts";
import { probeUrl } from "../src/health-probe-core.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv, type Row } from "./row-type.ts";

function b64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A real Ed25519 pair, formatted the way the secret carries it. */
async function generateSecret(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  // The raw seed is the last 32 bytes of the PKCS#8 encoding.
  const seed = pkcs8.slice(pkcs8.length - 32);
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return `${b64url(seed)}.${b64url(publicRaw)}`;
}

beforeEach(() => resetBotSignerForTests());

describe("botSignerFromEnv", () => {
  test("absent, malformed, or wrong-length secrets all mean unsigned", async () => {
    assert.equal(await botSignerFromEnv(mockEnv()), null);
    for (const bad of [
      "not-a-key",
      "onlyonepart",
      "a.b.c",
      `${b64url(new Uint8Array(16))}.${b64url(new Uint8Array(32))}`,
      `${b64url(new Uint8Array(32))}.${b64url(new Uint8Array(16))}`,
      "!!!.###",
      // Valid base64url alphabet, invalid base64 length: the decode itself
      // throws and the catch answers null.
      "A.A",
    ]) {
      resetBotSignerForTests();
      assert.equal(
        await botSignerFromEnv(mockEnv({ METAGRAPH_BOT_SIGNING_KEY: bad })),
        null,
        `secret ${JSON.stringify(bad)} must disable signing, not throw`,
      );
    }
  });

  test("the signer is cached per secret value, and a rotation re-derives", async () => {
    const s1 = await generateSecret();
    const s2 = await generateSecret();
    const a = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: s1 }),
    );
    const b = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: s1 }),
    );
    assert.equal(a, b, "same secret, same signer instance");
    const c = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: s2 }),
    );
    assert.notEqual(a, c);
    assert.notEqual(a?.thumbprint, c?.thumbprint);
  });
});

test("a WebCrypto without Ed25519 disables signing instead of failing probes", async () => {
  // The platform guard: workerd and Node both support Ed25519 today, so the
  // arm is forced -- but the guard exists for the runtime that does not, and
  // the contract is unsigned probes, never a throw.
  const spy = vi
    .spyOn(crypto.subtle, "importKey")
    .mockRejectedValueOnce(new Error("Ed25519 unsupported"));
  try {
    const signer = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: await generateSecret() }),
    );
    assert.equal(signer, null);
  } finally {
    spy.mockRestore();
  }
});

describe("the signature", () => {
  test("verifies against the published JWK over the reconstructed base", async () => {
    const secret = await generateSecret();
    const signer = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: secret }),
    );
    assert.ok(signer);
    const headers = new Headers();
    await signer.sign("https://beamcore.b1m.ai/health?x=1", headers);

    const input = headers.get("signature-input") ?? "";
    const sig = headers.get("signature") ?? "";
    assert.ok(input.startsWith("sig1=("));
    assert.ok(sig.startsWith("sig1=:") && sig.endsWith(":"));
    assert.equal(headers.get("signature-agent"), '"https://api.metagraph.sh"');
    assert.match(input, /tag="web-bot-auth"/);
    assert.match(input, /keyid="[A-Za-z0-9_-]+"/);
    assert.match(input, /created=\d+;expires=\d+/);
    // expires - created stays inside the draft's "a minute is often
    // sufficient" guidance, with margin for transit.
    const created = Number(/created=(\d+)/.exec(input)![1]);
    const expires = Number(/expires=(\d+)/.exec(input)![1]);
    assert.ok(expires - created >= 60 && expires - created <= 300);

    // THE VERIFIER'S VIEW: rebuild the signature base exactly as RFC 9421
    // says a receiver does, and verify with the directory's JWK.
    const params = input.slice("sig1=".length);
    const base = `"@authority": beamcore.b1m.ai\n"@signature-params": ${params}`;
    const jwk = signer.publicJwk as unknown as JsonWebKey;
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(sig.slice(6, -1)), (c) =>
      c.charCodeAt(0),
    );
    assert.equal(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        sigBytes,
        new TextEncoder().encode(base),
      ),
      true,
      "the signature must verify over the reconstructed base",
    );

    // And it must NOT verify for a different authority: @authority is the
    // whole point of the component set -- a replay against another host fails.
    const wrongBase = `"@authority": other.example\n"@signature-params": ${params}`;
    assert.equal(
      await crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        sigBytes,
        new TextEncoder().encode(wrongBase),
      ),
      false,
    );
  });

  test("keyid is the RFC 7638 thumbprint of the published JWK", async () => {
    const signer = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: await generateSecret() }),
    );
    assert.ok(signer);
    const jwk = signer.publicJwk as Row;
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}"}`;
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical),
      ),
    );
    assert.equal(signer.thumbprint, b64url(digest));
    const headers = new Headers();
    await signer.sign("https://example.com/", headers);
    assert.match(
      headers.get("signature-input") || "",
      new RegExp(`keyid="${signer.thumbprint}"`),
    );
  });

  test("an unparseable URL leaves the request unsigned rather than failing it", async () => {
    const signer = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: await generateSecret() }),
    );
    const headers = new Headers();
    await signer!.sign("not a url", headers);
    assert.equal(headers.get("signature"), null);
  });
});

describe("the key directory", () => {
  test("404s when signing is off — absence, not an empty key list", async () => {
    const res = await botKeyDirectoryResponse(
      new Request(`https://api.metagraph.sh${BOT_KEY_DIRECTORY_PATH}`),
      mockEnv(),
    );
    assert.equal(res.status, 404);
  });

  test("serves the JWKS with the draft's content type, itself signed", async () => {
    const secret = await generateSecret();
    const env = mockEnv({ METAGRAPH_BOT_SIGNING_KEY: secret });
    const res = await botKeyDirectoryResponse(
      new Request(`https://api.metagraph.sh${BOT_KEY_DIRECTORY_PATH}`),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      BOT_KEY_DIRECTORY_CONTENT_TYPE,
    );
    // The directory response demonstrates possession: signed with the same
    // key it publishes.
    assert.ok(res.headers.get("signature-input"));
    assert.ok(res.headers.get("signature"));
    const body = (await res.json()) as { keys: Row[] };
    assert.equal(body.keys.length, 1);
    assert.equal(body.keys[0].kty, "OKP");
    assert.equal(body.keys[0].crv, "Ed25519");

    const head = await botKeyDirectoryResponse(
      new Request(`https://api.metagraph.sh${BOT_KEY_DIRECTORY_PATH}`, {
        method: "HEAD",
      }),
      env,
    );
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  });

  test("is reachable through the real router", async () => {
    const res = await handleRequest(
      new Request(`https://api.metagraph.sh${BOT_KEY_DIRECTORY_PATH}`),
      mockEnv(),
      {} as never,
    );
    // No key configured in the mock env: the route dispatches and answers the
    // handler's own 404, which is the proof the wiring exists.
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "no signing key configured");
  });
});

describe("the probe carries the signature", () => {
  test("probeUrl stamps the headers when a signer is supplied, and not otherwise", async () => {
    const secret = await generateSecret();
    const signer = await botSignerFromEnv(
      mockEnv({ METAGRAPH_BOT_SIGNING_KEY: secret }),
    );
    // A holder object rather than a bare let: the assignment happens inside
    // the fetch closure, which TypeScript's narrowing cannot see.
    const captured: { headers: Headers | null } = { headers: null };
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      captured.headers = new Headers(init?.headers);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await probeUrl(
      "https://beamcore.b1m.ai/health",
      "GET",
      "application/json",
      5000,
      {
        isUnsafeUrl: () => false,
        fetchImpl,
        signRequest: signer!.sign,
      },
    );
    assert.ok(captured.headers);
    assert.ok(
      captured.headers.get("signature-input"),
      "signed probe carries the input",
    );
    assert.ok(captured.headers.get("signature"));
    assert.equal(
      captured.headers.get("user-agent"),
      "metagraphed-smoke-probe/0.0",
    );

    captured.headers = null;
    await probeUrl(
      "https://beamcore.b1m.ai/health",
      "GET",
      "application/json",
      5000,
      {
        isUnsafeUrl: () => false,
        fetchImpl,
      },
    );
    // Read through a call so the earlier `= null` narrowing does not stick.
    const second = ((): Headers | null => captured.headers)();
    assert.ok(second);
    assert.equal(
      second.get("signature"),
      null,
      "no signer, no signature -- the pre-existing wire shape",
    );
  });
});
