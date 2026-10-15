import assert from "node:assert/strict";
import { test } from "vitest";
import { coalescedReadMemo } from "../src/coalesced-read-memo.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("ten simultaneous cold reads share one pending load and retain the original TTL", async () => {
  const flight = deferred<string | null>();
  let calls = 0;
  const memo = coalescedReadMemo(async () => {
      calls++;
      return flight.promise;
    }, 60000),
    env = {};
  const pending = Array.from({ length: 10 }, () => memo.read(env, 1000));
  await Promise.resolve();
  assert.equal(calls, 1);
  flight.resolve("value");
  assert.deepEqual(await Promise.all(pending), Array(10).fill("value"));
  await memo.read(env, 60999);
  assert.equal(calls, 1);
  await memo.read(env, 61000);
  assert.equal(calls, 2);
});

test("environment identity is isolated even when flights settle out of order", async () => {
  const a = deferred<string | null>(),
    b = deferred<string | null>(),
    envA = {},
    envB = {};
  const memo = coalescedReadMemo(
    async (env) => (env === envA ? a.promise : b.promise),
    60000,
  );
  const first = memo.read(envA, 1),
    second = memo.read(envB, 1);
  b.resolve("b");
  a.resolve("a");
  assert.equal(await first, "a");
  assert.equal(await second, "b");
  assert.equal(await memo.read(envA, 2), "a");
  assert.equal(await memo.read(envB, 2), "b");
});

test("null and rejected reads clear only their own flight and remain retryable", async () => {
  let calls = 0;
  const memo = coalescedReadMemo(async () => {
      calls++;
      if (calls === 1) return null;
      if (calls === 2) throw new Error("store unavailable");
      return "fresh";
    }, 60000),
    env = {};
  assert.deepEqual(await Promise.all([memo.read(env, 1), memo.read(env, 1)]), [
    null,
    null,
  ]);
  assert.equal(calls, 1);
  await assert.rejects(memo.read(env, 2), /unavailable/);
  assert.equal(await memo.read(env, 3), "fresh");
  assert.equal(calls, 3);
});

test("expired or reset flights cannot repopulate or erase a newer null/error/value result", async () => {
  for (const result of ["old", null, "error"] as const) {
    const old = deferred<string | null>(),
      fresh = deferred<string | null>();
    let calls = 0;
    const memo = coalescedReadMemo(
        async () => (++calls === 1 ? old.promise : fresh.promise),
        10,
      ),
      env = {};
    const first = memo.read(env, 1);
    await Promise.resolve();
    const newer = memo.read(env, 11);
    await Promise.resolve();
    fresh.resolve("new");
    assert.equal(await newer, "new");
    if (result === "error") {
      old.reject(new Error("old failure"));
      await assert.rejects(first);
    } else {
      old.resolve(result);
      await first;
    }
    assert.equal(await memo.read(env, 12), "new");
    assert.equal(calls, 2);
  }
  const old = deferred<string | null>();
  let calls = 0;
  const memo = coalescedReadMemo(
      async () => (++calls === 1 ? old.promise : "after-reset"),
      60000,
    ),
    env = {};
  const before = memo.read(env, 1);
  await Promise.resolve();
  memo.reset();
  assert.equal(await memo.read(env, 2), "after-reset");
  old.resolve(null);
  await before;
  assert.equal(await memo.read(env, 3), "after-reset");
  assert.equal(calls, 2);
});
