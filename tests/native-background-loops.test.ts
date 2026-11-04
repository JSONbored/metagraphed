import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createNativeBackgroundLoops,
  type NativeBackgroundOptions,
} from "../src/native-background-loops.ts";
import { PG_QUEUE_CONCURRENCY, PG_QUEUE_NAMES } from "../src/pg-queue.ts";

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const calls: string[] = [];
  const errors: { error: unknown; loop: string }[] = [];
  const scheduled = (owner: string) => async () => {
    calls.push(`scheduled:${owner}`);
  };
  const consume = (owner: string) => async (batch: MessageBatch<unknown>) => {
    calls.push(`${owner}:${batch.queue}`);
  };
  let nextOwner = 0;
  const owners = ["api", "data", "registry"] as const;
  const options: NativeBackgroundOptions = {
    cron: {
      async register(boundary) {
        calls.push(`register:${boundary}`);
      },
      async plan() {
        calls.push("plan");
        return { throughMs: 1, planned: [] };
      },
      async run(run) {
        calls.push("cron");
        await run(
          owners[nextOwner++ % owners.length]!,
          { cron: "* * * * *", scheduledTime: 1 },
          new AbortController().signal,
        );
        return { status: "empty" };
      },
    },
    queues: {
      async run(queue, run) {
        calls.push(`queue:${queue}`);
        await run(
          {
            queue,
            messages: [],
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
            ackAll() {},
            retryAll() {},
          },
          new AbortController().signal,
        );
        return {
          status: "empty",
          acknowledged: 0,
          retried: 0,
          deadLettered: 0,
          parked: 0,
        };
      },
    },
    owners: {
      api: { scheduled: scheduled("api"), queue: consume("api") },
      data: { scheduled: scheduled("data"), queue: consume("data") },
      registry: { scheduled: scheduled("registry") },
    },
    mcp: {
      async runDueAlarms(limit) {
        calls.push(`mcp:${limit}`);
        return { completed: 0, rearmed: 0, skipped: 0, failed: 0 };
      },
    },
    chain: {
      async runDueAlarm() {
        calls.push("chain");
        return "skipped";
      },
    },
    rpc: {
      async flush() {
        calls.push("flush");
        return 0;
      },
      async prune() {
        calls.push("prune");
        return 0;
      },
    },
    auth: {
      async pruneExpiredRates(limit) {
        calls.push(`auth:${limit}`);
        return 0;
      },
    },
    cadence: {
      cronPlan: 100,
      cronRun: 100,
      queues: 100,
      mcpAlarms: 100,
      chainAlarm: 100,
      rpcFlush: 100,
      rpcPrune: 100,
      authPrune: 100,
    },
    cronRunners: 3,
    mcpAlarmBatch: 7,
    authPruneBatch: 11,
    stopTimeoutMillis: 50,
    onError(error, loop) {
      errors.push({ error, loop });
    },
  };
  return { options, calls, errors };
}

test("requires complete bounded capabilities without starting work", async () => {
  const { options, calls } = fixture();
  for (const name of Object.keys(
    options.cadence,
  ) as (keyof typeof options.cadence)[])
    for (const value of [undefined, 0, 9, 3600001, NaN, 1.5])
      assert.throws(
        () =>
          createNativeBackgroundLoops({
            ...options,
            cadence: { ...options.cadence, [name]: value },
          }),
        RangeError,
      );
  for (const [name, maximum] of [
    ["cronRunners", 100],
    ["mcpAlarmBatch", 100],
    ["authPruneBatch", 10000],
    ["stopTimeoutMillis", 3600000],
  ] as const)
    for (const value of [0, maximum + 1, NaN, 1.5])
      assert.throws(
        () => createNativeBackgroundLoops({ ...options, [name]: value }),
        RangeError,
      );
  for (const name of ["register", "plan", "run"] as const)
    assert.throws(
      () =>
        createNativeBackgroundLoops({
          ...options,
          cron: { ...options.cron, [name]: undefined },
        } as unknown as NativeBackgroundOptions),
      /required/,
    );
  for (const [name, key] of [
    ["queues", "run"],
    ["mcp", "runDueAlarms"],
    ["chain", "runDueAlarm"],
    ["rpc", "flush"],
    ["rpc", "prune"],
    ["auth", "pruneExpiredRates"],
  ] as const)
    assert.throws(
      () =>
        createNativeBackgroundLoops({
          ...options,
          [name]: { ...options[name], [key]: undefined },
        } as unknown as NativeBackgroundOptions),
      /required/,
    );
  for (const owner of ["api", "data", "registry"] as const)
    assert.throws(
      () =>
        createNativeBackgroundLoops({
          ...options,
          owners: { ...options.owners, [owner]: {} },
        } as unknown as NativeBackgroundOptions),
      /required/,
    );
  for (const owner of ["api", "data"] as const)
    assert.throws(
      () =>
        createNativeBackgroundLoops({
          ...options,
          owners: {
            ...options.owners,
            [owner]: { ...options.owners[owner], queue: undefined },
          },
        } as unknown as NativeBackgroundOptions),
      /required/,
    );
  assert.throws(
    () =>
      createNativeBackgroundLoops({
        ...options,
        onError: undefined,
      } as unknown as NativeBackgroundOptions),
    /reporter/,
  );
  const loops = createNativeBackgroundLoops(options);
  assert.equal(loops.state, "ready");
  assert.deepEqual(calls, []);
  assert.equal(vi.getTimerCount(), 0);
  await loops.stop();
  assert.equal(loops.state, "stopped");
  await assert.rejects(loops.start(0), /cannot start/);
});

test("registers one boundary then dispatches every owner, queue and maintenance lane", async () => {
  const { options, calls } = fixture();
  const loops = createNativeBackgroundLoops(options);
  assert(Object.isFrozen(loops));
  for (const value of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => loops.start(value), RangeError);
  const starting = loops.start(123);
  assert.equal(loops.start(123), starting);
  assert.equal(loops.state, "starting");
  await assert.rejects(loops.start(124), /cannot start/);
  await starting;
  await settle();
  assert.equal(loops.state, "running");
  assert.equal(loops.start(123), starting);
  assert.equal(calls[0], "register:123");
  assert.equal(calls.filter((call) => call.startsWith("register:")).length, 1);
  for (const owner of ["api", "data", "registry"])
    assert(calls.includes(`scheduled:${owner}`));
  for (const name of PG_QUEUE_NAMES) {
    const count = PG_QUEUE_CONCURRENCY[name];
    assert.equal(
      calls.filter((call) => call === `queue:${name}`).length,
      count,
    );
    const owner = name.startsWith("sync-batches") ? "data" : "api";
    assert.equal(
      calls.filter((call) => call === `${owner}:${name}`).length,
      count,
    );
  }
  for (const expected of [
    "plan",
    "mcp:7",
    "chain",
    "flush",
    "prune",
    "auth:11",
  ])
    assert(calls.includes(expected));
  assert.equal(loops.stats().active, 0);
  assert.equal(loops.stats().failed, 0);
  assert.equal(vi.getTimerCount(), loops.stats().loops);
  await vi.advanceTimersByTimeAsync(99);
  assert.equal(calls.filter((call) => call === "plan").length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(calls.filter((call) => call === "plan").length, 2);
  const stopping = loops.stop();
  assert.equal(loops.stop(), stopping);
  await stopping;
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(calls.length, count);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(loops.state, "stopped");
  await assert.rejects(loops.start(123), /cannot start/);
});

test("snapshots cadences, bounds, methods and receivers", async () => {
  const { options, calls } = fixture();
  options.rpc.flush = async function () {
    assert.equal(this, options.rpc);
    calls.push("captured");
    return 0;
  };
  const loops = createNativeBackgroundLoops(options);
  options.rpc.flush = async () => {
    throw new Error("replacement must not run");
  };
  options.owners.api.scheduled = async () => {
    throw new Error("replacement owner must not run");
  };
  options.cadence.rpcFlush = 10;
  options.mcpAlarmBatch = 99;
  options.authPruneBatch = 99;
  options.onError = () => {
    throw new Error("replacement reporter must not run");
  };
  await loops.start(0);
  await settle();
  assert(calls.includes("captured"));
  assert(calls.includes("mcp:7"));
  assert(calls.includes("auth:11"));
  assert.equal(loops.stats().failed, 0);
  await vi.advanceTimersByTimeAsync(99);
  assert.equal(calls.filter((call) => call === "captured").length, 1);
  await loops.stop();
});

test("each runner retains its slot until actual work settles and stop retains unfinished work", async () => {
  const { options, calls } = fixture();
  const held = deferred();
  options.rpc.flush = async () => {
    calls.push("held");
    await held.promise;
    return 0;
  };
  const loops = createNativeBackgroundLoops(options);
  await loops.start(0);
  await settle();
  assert.equal(loops.stats().active, 1);
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(calls.filter((call) => call === "held").length, 1);
  assert(calls.filter((call) => call === "plan").length > 1);
  const stopping = loops.stop();
  const failed = assert.rejects(stopping, /unfinished work remains/);
  assert.equal(loops.state, "stopping");
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  assert.equal(loops.stats().active, 1);
  const count = calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  assert.equal(calls.length, count);
  await assert.rejects(loops.start(0), /cannot start/);
  const retry = loops.stop();
  held.resolve();
  await retry;
  assert.equal(loops.state, "stopped");
  assert.equal(loops.stats().active, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("stop can finish after a timed-out attempt without another active waiter", async () => {
  const { options } = fixture();
  const held = deferred();
  options.rpc.flush = async () => {
    await held.promise;
    return 0;
  };
  const loops = createNativeBackgroundLoops(options);
  await loops.start(0);
  const rejected = assert.rejects(loops.stop(), /unfinished work/);
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  held.resolve();
  await settle();
  assert.equal(loops.state, "stopped");
  await loops.stop();
  assert.equal(loops.state, "stopped");
});

test("stopping during registration admits no background turns", async () => {
  const { options, calls } = fixture();
  const registration = deferred();
  options.cron.register = async () => {
    calls.push("register");
    await registration.promise;
  };
  const loops = createNativeBackgroundLoops(options);
  const starting = loops.start(0);
  const stopping = loops.stop();
  await settle();
  assert.deepEqual(calls, ["register"]);
  assert.equal(loops.state, "stopping");
  registration.resolve();
  await starting;
  await stopping;
  await vi.advanceTimersByTimeAsync(1000);
  assert.deepEqual(calls, ["register"]);
  assert.equal(loops.state, "stopped");
});

test("registration failure rejects startup without leaving loops or timers", async () => {
  const { options, calls, errors } = fixture();
  const failure = new Error("wrong source boundary");
  options.cron.register = async () => {
    throw failure;
  };
  const loops = createNativeBackgroundLoops(options);
  await assert.rejects(loops.start(1), failure);
  assert.equal(loops.state, "stopped");
  assert.deepEqual(errors, [{ error: failure, loop: "cron-register" }]);
  assert.deepEqual(calls, []);
  assert.equal(vi.getTimerCount(), 0);
  await assert.rejects(loops.start(1), /cannot start/);
  await loops.stop();
});

test("a dequeued timer cannot admit work after stop clears its timer", async () => {
  const { options, calls } = fixture();
  const timer = vi.spyOn(globalThis, "setTimeout");
  const loops = createNativeBackgroundLoops(options);
  await loops.start(0);
  await settle();
  const callbacks = timer.mock.calls.map(([callback]) => callback);
  await loops.stop();
  const count = calls.length;
  for (const callback of callbacks) {
    assert.equal(typeof callback, "function");
    if (typeof callback === "function") callback();
  }
  await settle();
  assert.equal(calls.length, count);
  assert.equal(loops.stats().active, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("failed registration during stop still rejects startup and completes drain", async () => {
  const { options, errors } = fixture();
  let rejectRegistration!: (error: unknown) => void;
  options.cron.register = () =>
    new Promise<void>((_resolve, reject) => {
      rejectRegistration = reject;
    });
  const loops = createNativeBackgroundLoops(options);
  const starting = loops.start(0);
  await settle();
  const stopping = loops.stop();
  const failure = new Error("registration failed during shutdown");
  const rejected = assert.rejects(starting, failure);
  rejectRegistration(failure);
  await rejected;
  await stopping;
  assert.equal(loops.state, "stopped");
  assert.deepEqual(errors, [{ error: failure, loop: "cron-register" }]);
  assert.equal(loops.stats().active, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test("reports synchronous and asynchronous turn failures with bounded retries", async () => {
  const { options, errors, calls } = fixture();
  const failure = new Error("temporary database outage");
  options.rpc.flush = () => {
    calls.push("flush-failed");
    throw failure;
  };
  options.rpc.prune = async () => {
    calls.push("prune-failed");
    throw failure;
  };
  const report = options.onError;
  options.onError = (error, loop) => {
    report(error, loop);
    throw new Error("reporting outage");
  };
  const loops = createNativeBackgroundLoops(options);
  await loops.start(0);
  await settle();
  assert.deepEqual(errors.map((row) => row.loop).sort(), [
    "rpc-flush",
    "rpc-prune",
  ]);
  assert(errors.every((row) => row.error === failure));
  assert.equal(loops.stats().failed, 2);
  assert.equal(loops.stats().active, 0);
  await vi.advanceTimersByTimeAsync(99);
  assert.equal(errors.length, 2);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(errors.length, 4);
  assert(calls.includes("chain"));
  await loops.stop();
});
