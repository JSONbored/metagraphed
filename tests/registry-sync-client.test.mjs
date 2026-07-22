// Unit tests for scripts/lib.mjs's registry-sync HTTP client helpers
// (postRegistrySync, chunkRows) -- the shared POST client
// scripts/sync-registry-to-postgres.mjs and scripts/backfill-registry-postgres.ts
// both call instead of touching Postgres directly.
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  REGISTRY_SYNC_DEFAULT_URL,
  REGISTRY_SYNC_MAX_BODY_BYTES,
  chunkRows,
  postRegistrySync,
} from "../scripts/lib.mjs";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.REGISTRY_SYNC_SECRET;
const originalUrl = process.env.REGISTRY_SYNC_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalSecret === undefined) delete process.env.REGISTRY_SYNC_SECRET;
  else process.env.REGISTRY_SYNC_SECRET = originalSecret;
  if (originalUrl === undefined) delete process.env.REGISTRY_SYNC_URL;
  else process.env.REGISTRY_SYNC_URL = originalUrl;
});

test("postRegistrySync no-ops (returns null) when REGISTRY_SYNC_SECRET is unset", async () => {
  delete process.env.REGISTRY_SYNC_SECRET;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };
  const result = await postRegistrySync({ providers: [] });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("postRegistrySync POSTs to the default URL with the secret header", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  delete process.env.REGISTRY_SYNC_URL;
  let seenUrl;
  let seenInit;
  globalThis.fetch = async (url, init) => {
    seenUrl = url;
    seenInit = init;
    return { ok: true, json: async () => ({ ok: true, providers_written: 1 }) };
  };
  const result = await postRegistrySync({ providers: [{ id: "acme" }] });
  assert.equal(seenUrl, REGISTRY_SYNC_DEFAULT_URL);
  assert.equal(seenInit.method, "POST");
  assert.equal(seenInit.headers["x-registry-sync-token"], "s3cr3t");
  assert.deepEqual(JSON.parse(seenInit.body), { providers: [{ id: "acme" }] });
  assert.deepEqual(result, { ok: true, providers_written: 1 });
});

test("postRegistrySync honors REGISTRY_SYNC_URL when set", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  process.env.REGISTRY_SYNC_URL = "https://staging.example.com/registry-sync";
  let seenUrl;
  globalThis.fetch = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({}) };
  };
  await postRegistrySync({ subnets: [] });
  assert.equal(seenUrl, "https://staging.example.com/registry-sync");
});

test("postRegistrySync throws with the response status + error on failure", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    json: async () => ({ error: "provide a valid token" }),
  });
  await assert.rejects(
    postRegistrySync({ providers: [] }),
    /failed \(401\): provide a valid token/,
  );
});

test("postRegistrySync falls back to statusText when the error body has no message", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    json: async () => ({}),
  });
  await assert.rejects(
    postRegistrySync({ providers: [] }),
    /failed \(502\): Bad Gateway/,
  );
});

test("postRegistrySync tolerates an unreadable response body", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  });
  assert.deepEqual(await postRegistrySync({ providers: [] }), {});
});

test("postRegistrySync throws before sending when the payload exceeds the byte budget", async () => {
  process.env.REGISTRY_SYNC_SECRET = "s3cr3t";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({}) };
  };
  const bigOverlay = "x".repeat(REGISTRY_SYNC_MAX_BODY_BYTES + 1);
  await assert.rejects(
    postRegistrySync({ subnets: [{ overlay: bigOverlay }] }),
    /exceeds the \d+-byte chunk budget/,
  );
  assert.equal(called, false);
});

test("chunkRows splits rows into groups of at most maxRows", () => {
  const rows = Array.from({ length: 5 }, (_, i) => i);
  const chunks = chunkRows(rows, 2);
  assert.deepEqual(chunks, [[0, 1], [2, 3], [4]]);
});

test("chunkRows returns a single empty chunk for an empty input", () => {
  assert.deepEqual(chunkRows([], 100), [[]]);
});

test("chunkRows returns one chunk when rows fit within maxRows", () => {
  assert.deepEqual(chunkRows([1, 2, 3], 10), [[1, 2, 3]]);
});
