import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createNativeWorkGroup,
  type NativeWorkScope,
} from "../src/native-work-group.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";
const options = {
  name: "Fixture",
  executionTimeoutMillis: 20,
  drainTimeoutMillis: 10,
};
afterEach(() => vi.useRealTimers());

test("validates deadlines and synchronous local admission", async () => {
  for (const key of ["executionTimeoutMillis", "drainTimeoutMillis"] as const)
    for (const value of [0, 3600001, 0.5, NaN])
      assert.throws(
        () => createNativeWorkGroup({ ...options, [key]: value }),
        RangeError,
      );
  const group = createNativeWorkGroup(options);
  for (const value of [0, 101, 0.5, NaN])
    await assert.rejects(
      group.run(
        "a",
        value,
        () => 0,
        async () => 1,
      ),
      RangeError,
    );
  assert.equal(group.state, "ready");
  const release = queueDeferred();
  const task = group.run(
    "a",
    1,
    () => 0,
    async () => {
      await release.promise;
      return 1;
    },
  );
  assert.equal(
    await group.run(
      "a",
      1,
      () => 0,
      async () => 2,
    ),
    0,
  );
  assert.equal(
    await group.run(
      "b",
      1,
      () => 0,
      async (scope) => scope.invoke(async () => 3),
    ),
    3,
  );
  release.resolve();
  assert.equal(await task, 1);
  assert.equal(await group.track(async () => 4), 4);
  const closing = group.close();
  assert.equal(group.close(), closing);
  await closing;
  assert.equal(group.state, "closed");
  await assert.rejects(
    group.track(async () => 1),
    /closed/,
  );
  await assert.rejects(
    group.run(
      "a",
      1,
      () => 0,
      async () => 1,
    ),
    /closed/,
  );
});

test("scope cannot be reused or escape its operation, and failure releases capacity", async () => {
  const group = createNativeWorkGroup(options);
  let saved!: NativeWorkScope;
  await group.run(
    "a",
    1,
    () => 0,
    async (scope) => {
      saved = scope;
      assert.equal(await scope.invoke(async () => 1), 1);
      await assert.rejects(
        scope.invoke(async () => 2),
        /scope is closed/,
      );
      return 3;
    },
  );
  await assert.rejects(
    saved.invoke(async () => 2),
    /scope is closed/,
  );
  await group.run(
    "a",
    1,
    () => 0,
    async (scope) => {
      saved = scope;
      return 3;
    },
  );
  await assert.rejects(
    saved.invoke(async () => 2),
    /scope is closed/,
  );
  await assert.rejects(
    group.run(
      "a",
      1,
      () => 0,
      async () => {
        throw new Error("failed");
      },
    ),
    /failed/,
  );
  assert.equal(
    await group.run(
      "a",
      1,
      () => 0,
      async () => 8,
    ),
    8,
  );
  await group.close();
});

test("unawaited consumer retains capacity after its outer operation ends", async () => {
  const group = createNativeWorkGroup(options),
    release = queueDeferred();
  let child!: Promise<number>;
  await group.run(
    "a",
    1,
    () => 0,
    async (scope) => {
      child = scope.invoke(async () => {
        await release.promise;
        return 4;
      });
      return 1;
    },
  );
  assert.equal(
    await group.run(
      "a",
      1,
      () => 0,
      async () => 5,
    ),
    0,
  );
  release.resolve();
  assert.equal(await child, 4);
  await group.close();
});

test("drain abort reaches a late consumer and close can succeed after an expired deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const group = createNativeWorkGroup(options),
    release = queueDeferred(),
    entered = queueDeferred();
  let aborted = false;
  const pending = group.run(
    "a",
    1,
    () => 0,
    async (scope) => {
      entered.resolve();
      await release.promise;
      return scope.invoke(
        async () => 1,
        () => {
          aborted = true;
        },
      );
    },
  );
  const failed = assert.rejects(pending, /drain deadline/);
  await entered.promise;
  const closing = assert.rejects(group.close(), /drain deadline/);
  await vi.advanceTimersByTimeAsync(10);
  await closing;
  release.resolve();
  await failed;
  assert.equal(aborted, true);
  await group.close();
});

test("execution deadline without abort observer releases a cooperative consumer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const group = createNativeWorkGroup(options),
    entered = queueDeferred();
  const pending = assert.rejects(
    group.run(
      "a",
      1,
      () => 0,
      async (scope) =>
        scope.invoke(async (signal) => {
          entered.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return 1;
        }),
    ),
    /execution deadline/,
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(20);
  await pending;
  await group.close();
});
