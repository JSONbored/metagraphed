import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { latestPointer } from "../workers/storage.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { mockEnv } from "./row-type.ts";

afterEach(() => {
  resetModuleState();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

test("parallel cold reads share one lookup and the identical pointer", async () => {
  const lookup = deferred<{ registry_manifest_sha256: string }>();
  const get = vi.fn(() => lookup.promise);
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  const first = latestPointer(env);
  const second = latestPointer(env);
  const third = latestPointer(env);
  assert.equal(get.mock.calls.length, 1);
  const pointer = { registry_manifest_sha256: "a".repeat(64) };
  lookup.resolve(pointer);
  for (const value of await Promise.all([first, second, third])) {
    assert.strictEqual(value, pointer);
  }
  assert.strictEqual(await latestPointer(env), pointer);
  assert.equal(get.mock.calls.length, 1);
});

test("coalescing does not extend the existing TTL from lookup start", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const began = Date.now();
  const lookup = deferred<{ latest_prefix: string }>();
  const get = vi.fn(() => lookup.promise);
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  const first = latestPointer(env);
  vi.setSystemTime(began + 50_000);
  const second = latestPointer(env);
  lookup.resolve({ latest_prefix: "first/" });
  await Promise.all([first, second]);
  vi.setSystemTime(began + 59_999);
  await latestPointer(env);
  assert.equal(get.mock.calls.length, 1);
  vi.setSystemTime(began + 60_000);
  await latestPointer(env);
  assert.equal(get.mock.calls.length, 2);
});

test("a lookup that outlasts the TTL is immediately eligible for refresh", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const began = Date.now();
  const lookup = deferred<{ latest_prefix: string }>();
  const get = vi
    .fn()
    .mockReturnValueOnce(lookup.promise)
    .mockResolvedValue({ latest_prefix: "new/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  const first = latestPointer(env);
  vi.setSystemTime(began + 70_000);
  lookup.resolve({ latest_prefix: "old/" });
  assert.equal((await first)?.latest_prefix, "old/");
  assert.equal((await latestPointer(env))?.latest_prefix, "new/");
  assert.equal(get.mock.calls.length, 2);
});

test("parallel reads in different environments cannot share a lookup", async () => {
  const a = deferred<{ latest_prefix: string }>();
  const b = deferred<{ latest_prefix: string }>();
  const getA = vi.fn(() => a.promise);
  const getB = vi.fn(() => b.promise);
  const envA = mockEnv({ METAGRAPH_CONTROL: { get: getA } });
  const envB = mockEnv({ METAGRAPH_CONTROL: { get: getB } });
  const pending = [
    latestPointer(envA),
    latestPointer(envB),
    latestPointer(envA),
    latestPointer(envB),
  ];
  assert.equal(getA.mock.calls.length, 1);
  assert.equal(getB.mock.calls.length, 1);
  b.resolve({ latest_prefix: "b/" });
  a.resolve({ latest_prefix: "a/" });
  assert.deepEqual(
    (await Promise.all(pending)).map((p) => p?.latest_prefix),
    ["a/", "b/", "a/", "b/"],
  );
});

test("a rejected lookup releases all waiters and permits an immediate retry", async () => {
  const lookup = deferred<{ latest_prefix: string }>();
  const get = vi
    .fn()
    .mockReturnValueOnce(lookup.promise)
    .mockResolvedValue({ latest_prefix: "recovered/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  const pending = [latestPointer(env), latestPointer(env)];
  lookup.reject(new Error("transient fixture failure"));
  assert.deepEqual(await Promise.all(pending), [null, null]);
  assert.equal((await latestPointer(env))?.latest_prefix, "recovered/");
  assert.equal(get.mock.calls.length, 2);
});

test("a synchronous binding failure does not pin a failed promise", async () => {
  const get = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("fixture failure");
    })
    .mockResolvedValue({ latest_prefix: "recovered/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  assert.equal(await latestPointer(env), null);
  assert.equal((await latestPointer(env))?.latest_prefix, "recovered/");
  assert.equal(get.mock.calls.length, 2);
});

test("a missing pointer keeps the existing negative-cache TTL", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const began = Date.now();
  const lookup = deferred<null>();
  const get = vi
    .fn()
    .mockReturnValueOnce(lookup.promise)
    .mockResolvedValue({ latest_prefix: "published/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  const pending = [latestPointer(env), latestPointer(env)];
  lookup.resolve(null);
  assert.deepEqual(await Promise.all(pending), [null, null]);
  assert.equal(await latestPointer(env), null);
  assert.equal(get.mock.calls.length, 1);
  vi.setSystemTime(began + 60_000);
  assert.equal((await latestPointer(env))?.latest_prefix, "published/");
  assert.equal(get.mock.calls.length, 2);
});

test("failed refreshes do not serve an expired pointer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const began = Date.now();
  const get = vi
    .fn()
    .mockResolvedValueOnce({ latest_prefix: "expired/" })
    .mockRejectedValueOnce(new Error("fixture failure"))
    .mockResolvedValue({ latest_prefix: "current/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  await latestPointer(env);
  vi.setSystemTime(began + 60_000);
  assert.equal(await latestPointer(env), null);
  assert.equal((await latestPointer(env))?.latest_prefix, "current/");
  assert.equal(get.mock.calls.length, 3);
});

test("module reset releases completed memo state", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({ latest_prefix: "first/" })
    .mockResolvedValue({ latest_prefix: "second/" });
  const env = mockEnv({ METAGRAPH_CONTROL: { get } });
  assert.equal((await latestPointer(env))?.latest_prefix, "first/");
  resetModuleState();
  assert.equal((await latestPointer(env))?.latest_prefix, "second/");
  assert.equal(get.mock.calls.length, 2);
});
