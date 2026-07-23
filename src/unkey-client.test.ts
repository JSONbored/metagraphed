import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  createUnkeyKey,
  verifyUnkeyKey,
  updateUnkeyKeyTier,
  revokeUnkeyKey,
} from "./unkey-client.ts";

const ENV = {
  UNKEY_ROOT_KEY: "test-root-key-placeholder",
  UNKEY_API_ID: "api_test123",
} as unknown as Env;

function mockJsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (data === undefined ? {} : { data }),
  };
}

type CapturedBody = Record<string, unknown>;

describe("createUnkeyKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("mints a key and returns keyId/key", async () => {
    let capturedBody: CapturedBody = {};
    vi.stubGlobal(
      "fetch",
      async (
        url: string,
        opts: { body: string; headers: Record<string, string> },
      ) => {
        capturedBody = JSON.parse(opts.body);
        assert.equal(url, "https://api.unkey.com/v2/keys.createKey");
        assert.equal(
          opts.headers.authorization,
          "Bearer test-root-key-placeholder",
        );
        return mockJsonResponse(200, { keyId: "key_abc", key: "mg_secret123" });
      },
    );

    const result = await createUnkeyKey(ENV, {
      externalId: "42",
      tier: "free",
    });

    assert.deepEqual(result, {
      ok: true,
      keyId: "key_abc",
      key: "mg_secret123",
    });
    assert.equal(capturedBody.apiId, "api_test123");
    assert.equal(capturedBody.externalId, "42");
    assert.deepEqual(capturedBody.meta, { tier: "free" });
    assert.equal(capturedBody.ratelimits, undefined);
  });

  test("fails closed when env is missing UNKEY_ROOT_KEY/UNKEY_API_ID", async () => {
    const result = await createUnkeyKey({} as unknown as Env, {
      externalId: "42",
      tier: "free",
    });
    assert.deepEqual(result, { ok: false, code: "provider_not_configured" });
  });

  test("fails closed on a network error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const result = await createUnkeyKey(ENV, {
      externalId: "42",
      tier: "free",
    });
    assert.deepEqual(result, { ok: false, code: "provider_unreachable" });
  });

  test("fails closed on a malformed response body", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    }));
    const result = await createUnkeyKey(ENV, {
      externalId: "42",
      tier: "free",
    });
    assert.deepEqual(result, { ok: false, code: "provider_invalid_response" });
  });

  test("fails closed on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => mockJsonResponse(401, undefined));
    const result = await createUnkeyKey(ENV, {
      externalId: "42",
      tier: "free",
    });
    assert.deepEqual(result, {
      ok: false,
      code: "provider_error",
      status: 401,
    });
  });
});

describe("verifyUnkeyKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("returns valid + tier + accountId on a clean verify", async () => {
    let capturedBody: CapturedBody = {};
    vi.stubGlobal(
      "fetch",
      async (
        url: string,
        opts: { body: string; headers: Record<string, string> },
      ) => {
        capturedBody = JSON.parse(opts.body);
        assert.equal(url, "https://api.unkey.com/v2/keys.verifyKey");
        return mockJsonResponse(200, {
          valid: true,
          code: "VALID",
          keyId: "key_abc",
          meta: { tier: "free" },
          identity: { id: "id_1", externalId: "42" },
        });
      },
    );

    const result = await verifyUnkeyKey(ENV, "mg_secret123");

    assert.deepEqual(capturedBody, { key: "mg_secret123" });
    assert.deepEqual(result, {
      ok: true,
      valid: true,
      code: "VALID",
      keyId: "key_abc",
      tier: "free",
      accountId: "42",
    });
  });

  test("returns valid:false with the Unkey-provided code for a revoked/missing key", async () => {
    vi.stubGlobal("fetch", async () =>
      mockJsonResponse(200, { valid: false, code: "NOT_FOUND" }),
    );
    const result = await verifyUnkeyKey(ENV, "mg_bogus");
    assert.equal((result as CapturedBody).ok, true);
    assert.equal((result as CapturedBody).valid, false);
    assert.equal((result as CapturedBody).code, "NOT_FOUND");
  });

  test("null tier/accountId when meta/identity are absent", async () => {
    vi.stubGlobal("fetch", async () =>
      mockJsonResponse(200, { valid: true, code: "VALID" }),
    );
    const result = await verifyUnkeyKey(ENV, "mg_secret123");
    assert.equal((result as CapturedBody).tier, null);
    assert.equal((result as CapturedBody).accountId, null);
  });

  test("fails closed when Unkey is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    const result = await verifyUnkeyKey(ENV, "mg_secret123");
    assert.deepEqual(result, { ok: false, code: "provider_unreachable" });
  });
});

describe("updateUnkeyKeyTier", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("updates the display-only meta.tier by keyId", async () => {
    let capturedBody: CapturedBody = {};
    vi.stubGlobal(
      "fetch",
      async (
        url: string,
        opts: { body: string; headers: Record<string, string> },
      ) => {
        capturedBody = JSON.parse(opts.body);
        assert.equal(url, "https://api.unkey.com/v2/keys.updateKey");
        return mockJsonResponse(200, {});
      },
    );

    const result = await updateUnkeyKeyTier(ENV, {
      keyId: "key_abc",
      tier: "unlimited",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(capturedBody, {
      keyId: "key_abc",
      meta: { tier: "unlimited" },
    });
  });
});

describe("revokeUnkeyKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("disables (not deletes) by keyId", async () => {
    let capturedBody: CapturedBody = {};
    vi.stubGlobal(
      "fetch",
      async (
        url: string,
        opts: { body: string; headers: Record<string, string> },
      ) => {
        capturedBody = JSON.parse(opts.body);
        assert.equal(url, "https://api.unkey.com/v2/keys.updateKey");
        return mockJsonResponse(200, {});
      },
    );

    const result = await revokeUnkeyKey(ENV, "key_abc");

    assert.equal(result.ok, true);
    assert.deepEqual(capturedBody, { keyId: "key_abc", enabled: false });
  });
});
