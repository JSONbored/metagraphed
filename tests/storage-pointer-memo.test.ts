import assert from "node:assert/strict";
import { test } from "vitest";
import { latestPointer } from "../workers/storage.ts";
import { mockEnv } from "./row-type.ts";

test("latestPointer memoizes within the TTL — one KV read for repeated same-env calls (#367)", async () => {
  let gets = 0;
  const env = mockEnv({
    METAGRAPH_CONTROL: {
      async get() {
        gets += 1;
        return {
          latest_prefix: "latest/",
          published_at: "2026-06-21T00:00:00.000Z",
        };
      },
    },
  });
  const a = await latestPointer(env);
  const b = await latestPointer(env);
  assert.equal(a!.published_at, "2026-06-21T00:00:00.000Z");
  assert.deepEqual(a, b);
  assert.equal(
    gets,
    1,
    "the second call within the TTL must be served from the in-isolate memo",
  );
});

test("latestPointer never cross-reads a different env (test isolation + multi-binding safety)", async () => {
  let gets = 0;
  const mkEnv = (pub: string) =>
    mockEnv({
      METAGRAPH_CONTROL: {
        async get() {
          gets += 1;
          return { latest_prefix: "latest/", published_at: pub };
        },
      },
    });
  const first = await latestPointer(mkEnv("a"));
  const second = await latestPointer(mkEnv("b"));
  assert.equal(first!.published_at, "a");
  assert.equal(
    second!.published_at,
    "b",
    "a different env object must miss the memo",
  );
  assert.equal(gets, 2);
});

test("latestPointer returns null (no memo poisoning) when the KV binding is absent", async () => {
  assert.equal(await latestPointer(mockEnv()), null);
});
