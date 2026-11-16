// The in-process REGISTRY_SYNC_API adapter (#13143) honors the service
// binding's contract exactly, auth gate included: whatever
// workers/registry-sync-api.ts answers across the binding, the adapter answers
// in-process, byte for byte. Same seam-only scope as
// tests/data-api-in-process.test.ts — the write tier's own behavior has its
// own suites.
import assert from "node:assert/strict";
import { test } from "vitest";
import registrySyncApi from "../workers/registry-sync-api.ts";
import { inProcessRegistrySyncApi } from "../workers/registry-sync-in-process.ts";
import {
  mergedRegistrySyncEnv,
  registrySyncEnv,
} from "./helpers/worker-env.ts";

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

const URL_ = "https://registry-sync.internal/";

test("a non-POST answers 405 identically across the binding and in-process", async () => {
  const env = mergedRegistrySyncEnv();
  const direct = await registrySyncApi.fetch(new Request(URL_), env);
  const adapted = await inProcessRegistrySyncApi(env).fetch(URL_);
  const expected = await snapshot(direct);
  assert.deepEqual(await snapshot(adapted), expected);
  assert.equal(expected.status, 405);
});

test("the unprovisioned deployment answers 503 identically", async () => {
  const env = mergedRegistrySyncEnv();
  const init = { method: "POST" };
  const direct = await registrySyncApi.fetch(new Request(URL_, init), env);
  const adapted = await inProcessRegistrySyncApi(env).fetch(URL_, init);
  const expected = await snapshot(direct);
  assert.deepEqual(await snapshot(adapted), expected);
  assert.equal(expected.status, 503);
});

test("the auth gate rejects a bad token in-process exactly as across the binding", async () => {
  const env = mergedRegistrySyncEnv(
    registrySyncEnv({ REGISTRY_SYNC_SECRET: "right-token" }),
  );
  const init = {
    method: "POST",
    headers: { "x-registry-sync-token": "wrong-token" },
  };
  const direct = await registrySyncApi.fetch(new Request(URL_, init), env);
  const adapted = await inProcessRegistrySyncApi(env).fetch(URL_, init);
  const expected = await snapshot(direct);
  assert.deepEqual(await snapshot(adapted), expected);
  assert.equal(expected.status, 401);
});
