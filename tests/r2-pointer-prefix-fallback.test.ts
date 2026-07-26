import assert from "node:assert/strict";
import { test } from "vitest";
import { readR2 } from "../workers/storage.ts";
import { mockEnv } from "./row-type.ts";

/**
 * #8276: the KV pointer's `latest_prefix` named `runs/<runId>/` while #8237 had
 * moved the history tier to `by-hash/<sha256>`, so the prefix held no objects
 * and EVERY R2-backed route 404'd at once in production. #8278 fixed the
 * pointer writer, but a bad pointer already in KV keeps serving 404s until the
 * next successful publish rewrites it — so the read path recovers on its own.
 */

const ARTIFACT_PATH = "/metagraph/subnets/74.json";
const BODY = { schema_version: 1, netuid: 74 };

function r2WithOnlyLatest(seen: string[]) {
  return async (key: string) => {
    seen.push(String(key));
    if (String(key) !== "latest/subnets/74.json") return null;
    const text = JSON.stringify(BODY);
    return {
      async json() {
        return JSON.parse(text);
      },
      async text() {
        return text;
      },
    };
  };
}

function envWithPointerPrefix(prefix: string, seen: string[]) {
  // mockEnv is a bare cast, so every binding the code path reads is supplied
  // here: the R2 archive plus the KV namespace latestPointer() reads the
  // metagraph:latest control record from.
  return mockEnv({
    METAGRAPH_ARCHIVE: { get: r2WithOnlyLatest(seen) },
    METAGRAPH_CONTROL: { get: async () => ({ latest_prefix: prefix }) },
  });
}

test("a pointer prefix that holds no objects falls back to the latest/ tree", async () => {
  const seen: string[] = [];
  const env = envWithPointerPrefix("runs/2026-07-26T10-59-03-643Z/", seen);

  const result = await readR2(env, ARTIFACT_PATH, "r2");

  assert.equal(result.ok, true, "expected the fallback read to succeed");
  assert.deepEqual(result.data, BODY);
  // Tried the pointer's prefix first, then the literal latest/ key.
  assert.deepEqual(seen, [
    "runs/2026-07-26T10-59-03-643Z/subnets/74.json",
    "latest/subnets/74.json",
  ]);
});

test("a healthy latest/ pointer costs no extra round-trip", async () => {
  const seen: string[] = [];
  const env = envWithPointerPrefix("latest/", seen);

  const result = await readR2(env, ARTIFACT_PATH, "r2");

  assert.equal(result.ok, true);
  // Exactly one read: the fallback key equals the primary key, so it is skipped.
  assert.deepEqual(seen, ["latest/subnets/74.json"]);
});

test("a genuinely missing artifact still 404s rather than falling back forever", async () => {
  const seen: string[] = [];
  const env = mockEnv({
    METAGRAPH_ARCHIVE: {
      get: async (key: string) => {
        seen.push(String(key));
        return null;
      },
    },
    METAGRAPH_CONTROL: {
      get: async () => ({ latest_prefix: "runs/whatever/" }),
    },
  });

  const result = await readR2(env, ARTIFACT_PATH, "r2");

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "artifact_not_found");
  // Both keys attempted, then a real 404 — never an infinite retry.
  assert.equal(seen.length, 2);
});
