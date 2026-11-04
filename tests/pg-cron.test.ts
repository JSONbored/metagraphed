import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
  createPgCronDispatcher,
  createPgCronScheduler,
} from "../src/pg-cron.ts";
import { NativeScheduledBackgroundError } from "../src/native-api-process.ts";
import { parseNativeCron } from "../src/native-cron.ts";
import {
  cronDefinitions,
  cronFixture,
  cronLimits,
} from "./helpers/cron-fixture.ts";
import { queueDeferred } from "./helpers/queue-fixture.ts";

let db: PGlite;
let f: Awaited<ReturnType<typeof cronFixture>>;
beforeAll(() => {
  db = new PGlite();
});
beforeEach(async () => {
  f = await cronFixture(db);
});
afterAll(async () => {
  await db.close();
});
const minute = 60000;
const all = async (table: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM jobs.${table}`)).rows;
const ready = async () => {
  await f.scheduler.register(0);
  return f.scheduler.plan();
};
const expire = () =>
  db.exec(
    "UPDATE jobs.cron_runs SET started_at_ms=scheduled_at_ms,lease_until_ms=scheduled_at_ms WHERE state='running'",
  );

test("validates finite policy, unique supported inventory, and persistent peer configuration", async () => {
  for (const [name, values] of Object.entries({
    maxConcurrent: [0, 101, 0.5],
    leaseMilliseconds: [0, 3600001, NaN],
    executionTimeoutMillis: [0, 3600001, Infinity],
    drainTimeoutMillis: [0, 3600001, NaN],
    maxAttempts: [0, 101, 0.5],
    historyLimit: [0, 10001, NaN],
  }))
    for (const value of values)
      await assert.rejects(
        createPgCronScheduler(f.runtime, cronDefinitions, {
          ...cronLimits,
          [name]: value,
        }),
        /Invalid cron/,
      );
  await assert.rejects(
    createPgCronScheduler(f.runtime, cronDefinitions, {
      ...cronLimits,
      executionTimeoutMillis: 60000,
    }),
    /precede lease/,
  );
  for (const definitions of [
    [],
    Array.from({ length: 101 }, () => cronDefinitions[0]!),
    [cronDefinitions[0]!, cronDefinitions[0]!],
    [{ owner: "unknown", cron: "* * * * *" }],
  ])
    await assert.rejects(
      createPgCronScheduler(
        f.runtime,
        definitions as typeof cronDefinitions,
        cronLimits,
      ),
    );
  await assert.rejects(
    createPgCronScheduler(f.runtime, cronDefinitions, {
      ...cronLimits,
      maxConcurrent: 1,
    }),
    /policy differs/,
  );
  await db.exec("DELETE FROM jobs.cron_policy");
  await assert.rejects(f.scheduler.plan(), /policy differs/);
});

test("requires explicit immutable registration and refuses foreign or incomplete stored inventories", async () => {
  assert.deepEqual((await f.scheduler.plan()).planned, []);
  assert.deepEqual(
    await f.scheduler.run(async () => {
      throw new Error("unregistered");
    }),
    { status: "empty" },
  );
  for (const value of [-1, Infinity, NaN, 0.1])
    await assert.rejects(f.scheduler.register(value), /start boundary/);
  const future = Date.now() + 60000;
  await f.scheduler.register(future);
  await f.scheduler.register(future);
  assert.deepEqual((await f.scheduler.plan()).planned, []);
  await assert.rejects(f.scheduler.register(0), /start boundary differs/);
  await db.exec("UPDATE jobs.cron_schedules SET cron='1 * * * *'");
  await assert.rejects(f.scheduler.plan(), /inventory differs/);
  await db.exec("DELETE FROM jobs.cron_schedules");
  const two = await createPgCronScheduler(
    f.runtime,
    [...cronDefinitions, { owner: "data", cron: "* * * * *" }],
    cronLimits,
  );
  await two.register(0);
  await db.exec("DELETE FROM jobs.cron_schedules WHERE owner='data'");
  await assert.rejects(two.plan(), /inventory differs/);
});

test("coalesces missed slots with exact skipped ranges and lifetime counts, without replaying probes", async () => {
  const planned = await ready();
  const expected = parseNativeCron("* * * * *").window(-1, planned.throughMs);
  assert.deepEqual(planned.planned, [
    {
      owner: "api",
      cron: "* * * * *",
      scheduledTime: expected.last,
      skipped: expected.count - 1,
    },
  ]);
  const receipt = (await all("cron_skips"))[0]!;
  assert.equal(Number(receipt.first_at_ms), 0);
  assert.equal(Number(receipt.last_at_ms), expected.previous);
  assert.equal(Number(receipt.slot_count), expected.count - 1);
  assert.deepEqual((await f.scheduler.plan()).planned, []);
  const result = await f.scheduler.run(async (owner, event) => {
    assert.equal(owner, "api");
    assert.equal(event.cron, "* * * * *");
    assert.equal(event.scheduledTime, expected.last);
    return { ok: true };
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(await f.scheduler.run(async () => {}), { status: "empty" });
  assert.equal(
    Number((await all("cron_schedules"))[0]!.skipped_count),
    expected.count - 1,
  );
});

test("supersedes only the pending slot and bounds retained receipts while keeping cumulative skips", async () => {
  await f.scheduler.register(0);
  const slot = Math.floor(Date.now() / minute) * minute;
  for (let index = 0; index < 4; index++) {
    await db.query(
      "UPDATE jobs.cron_schedules SET cursor_ms=$1,pending_at_ms=$2",
      [slot - 2 * minute - 1, slot - 3 * minute],
    );
    const planned = await f.scheduler.plan();
    assert.equal(planned.planned[0]!.skipped, 3);
    const last = (await all("cron_skips")).find(
      (row) => Number(row.through_ms) === planned.throughMs,
    )!;
    assert.equal(Number(last.first_at_ms), slot - 3 * minute);
    assert.equal(Number(last.last_at_ms), slot - minute);
    await db.query(
      "UPDATE jobs.cron_skips SET through_ms=through_ms-$1 WHERE through_ms=$2",
      [(index + 1) * 1000, planned.throughMs],
    );
  }
  assert.equal((await all("cron_skips")).length, 2);
  assert.equal(Number((await all("cron_schedules"))[0]!.skipped_count), 12);
});

test("advances empty windows without manufacturing a due occurrence", async () => {
  f = await cronFixture(db, [{ owner: "api", cron: "1 0 * * *" }]);
  const now = Date.now();
  await f.scheduler.register(now);
  assert.deepEqual((await f.scheduler.plan()).planned, []);
  assert.ok(Number((await all("cron_schedules"))[0]!.cursor_ms) >= now);
  assert.equal((await all("cron_skips")).length, 0);
});

test("records success, normal domain decline and exceptions separately; never persists raw results or errors", async () => {
  await f.scheduler.register(0);
  const secret = "private-result-must-not-be-persisted";
  const handler = new Error(secret);
  const cases = [
    [undefined, "succeeded"],
    ["primitive", "succeeded"],
    [null, "succeeded"],
    [{ ok: true, skipped: false }, "succeeded"],
    [{ ok: false }, "declined"],
    [{ skipped: true }, "declined"],
    [handler, "handler-failed"],
    [
      new NativeScheduledBackgroundError(handler, { ok: false, secret }),
      "background-failed",
    ],
  ] as const;
  for (let index = 0; index < cases.length; index++) {
    await db.query(
      "UPDATE jobs.cron_schedules SET cursor_ms=$1,pending_at_ms=$1",
      [Math.floor(Date.now() / minute) * minute - index * minute],
    );
    const [value, outcome] = cases[index]!;
    const result = await f.scheduler.run(async () => {
      if (value instanceof Error) throw value;
      return value;
    });
    assert.equal(result.status, "completed");
    assert.ok("outcome" in result);
    assert.equal(result.outcome, outcome);
    const rows = await all("cron_runs");
    assert.ok(rows.length <= 2);
    const row = rows.find(
      (row) => Number(row.scheduled_at_ms) === result.scheduledTime,
    );
    // The history policy keeps the newest scheduled slots, even when an older slot is replayed deliberately.
    if (row) assert.equal(row.state, outcome);
    assert.ok(!JSON.stringify(rows).includes(secret));
  }
});

test("durable capacity and per-schedule custody coordinate independent scheduler instances", async () => {
  f = await cronFixture(db, [
    ...cronDefinitions,
    { owner: "data", cron: "* * * * *" },
    { owner: "registry", cron: "* * * * *" },
  ]);
  await ready();
  const peer = await createPgCronScheduler(f.runtime, f.definitions, f.limits);
  const entered = [queueDeferred(), queueDeferred()];
  const release = queueDeferred();
  const first = f.scheduler.run(async () => {
    entered[0]!.resolve();
    await release.promise;
  });
  await entered[0]!.promise;
  const second = peer.run(async () => {
    entered[1]!.resolve();
    await release.promise;
  });
  await entered[1]!.promise;
  assert.deepEqual(await peer.run(async () => {}), { status: "capacity" });
  assert.equal((await all("cron_runs")).length, 2);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal((await peer.run(async () => {})).status, "completed");
  await peer.close();
});

test("a lease reclaim fences late completion and retries the same scheduled occurrence", async () => {
  await ready();
  const peer = await createPgCronScheduler(f.runtime, f.definitions, f.limits);
  const entered = queueDeferred(),
    release = queueDeferred();
  const original = f.scheduler.run(async () => {
    entered.resolve();
    await release.promise;
    return { ok: false };
  });
  await entered.promise;
  assert.deepEqual(await peer.run(async () => {}), { status: "empty" });
  await expire();
  const retried = await peer.run(async () => ({ ok: true }));
  assert.equal(retried.status, "completed");
  release.resolve();
  const stale = await original;
  assert.equal(stale.status, "stale");
  const row = (await all("cron_runs"))[0]!;
  assert.equal(row.attempts, 2);
  assert.equal(row.state, "succeeded");
  assert.equal(row.result_ok, true);
  await peer.close();
});

test("expired leases stop at the finite attempt budget and retain an exhausted receipt", async () => {
  f = await cronFixture(db, cronDefinitions, { ...cronLimits, maxAttempts: 1 });
  await ready();
  const entered = queueDeferred(),
    release = queueDeferred();
  const pending = f.scheduler.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  await expire();
  const peer = await createPgCronScheduler(f.runtime, f.definitions, f.limits);
  const exhausted = await peer.run(async () => {
    throw new Error("must not execute");
  });
  assert.equal(exhausted.status, "lease-exhausted");
  assert.equal((await all("cron_runs"))[0]!.state, "lease-exhausted");
  release.resolve();
  assert.equal((await pending).status, "stale");
  await peer.close();
});

test("deadlines freeze an aborted outcome and retain uncooperative local capacity until exit", async () => {
  f = await cronFixture(db, cronDefinitions, {
    ...cronLimits,
    maxConcurrent: 1,
    executionTimeoutMillis: 20,
    drainTimeoutMillis: 10,
  });
  await ready();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const entered = queueDeferred(),
      release = queueDeferred();
    let signal!: AbortSignal;
    const pending = f.scheduler.run(async (_owner, _event, received) => {
      signal = received;
      entered.resolve();
      await release.promise;
      return { ok: true };
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    assert.equal(result.status, "completed");
    assert.ok("outcome" in result);
    assert.equal(result.outcome, "aborted");
    assert.equal(signal.aborted, true);
    assert.deepEqual(await f.scheduler.run(async () => {}), {
      status: "capacity",
    });
    const closing = assert.rejects(f.scheduler.close(), /drain deadline/);
    await vi.advanceTimersByTimeAsync(10);
    await closing;
    assert.equal(f.scheduler.state, "closing");
    await assert.rejects(f.scheduler.plan(), /transport is closed/);
    await assert.rejects(
      f.scheduler.run(async () => {}),
      /transport is closed/,
    );
    release.resolve();
    await f.scheduler.close();
    assert.equal(f.scheduler.state, "closed");
    assert.equal((await all("cron_runs"))[0]!.state, "aborted");
  } finally {
    vi.useRealTimers();
  }
});

test("owner dispatcher forwards the exact event, signal and result to each supplied process", async () => {
  f = await cronFixture(db, [
    ...cronDefinitions,
    { owner: "data", cron: "* * * * *" },
    { owner: "registry", cron: "* * * * *" },
  ]);
  await ready();
  const calls: string[] = [];
  const processes = Object.fromEntries(
    ["api", "data", "registry"].map((owner) => [
      owner,
      {
        scheduled: async (
          event: { cron: string; scheduledTime: number },
          signal?: AbortSignal,
        ) => {
          calls.push(owner);
          assert.equal(event.cron, "* * * * *");
          assert.ok(event.scheduledTime > 0);
          assert.ok(signal instanceof AbortSignal);
          return { ok: false };
        },
      },
    ]),
  );
  const dispatch = createPgCronDispatcher(
    f.scheduler,
    processes as Parameters<typeof createPgCronDispatcher>[1],
  );
  for (let index = 0; index < 3; index++) {
    const result = await dispatch();
    assert.ok("outcome" in result);
    assert.equal(result.outcome, "declined");
  }
  assert.deepEqual(calls.sort(), ["api", "data", "registry"]);
  const closing = f.scheduler.close();
  assert.equal(f.scheduler.close(), closing);
  await closing;
});

test("a single new occurrence records no skip unless it supersedes an existing pending slot", async () => {
  await f.scheduler.register(0);
  const slot = Math.floor(Date.now() / minute) * minute;
  await db.query("UPDATE jobs.cron_schedules SET cursor_ms=$1", [slot - 1]);
  assert.equal((await f.scheduler.plan()).planned[0]!.skipped, 0);
  assert.equal((await all("cron_skips")).length, 0);
  await db.query(
    "UPDATE jobs.cron_schedules SET cursor_ms=$1,pending_at_ms=$2",
    [slot - 1, slot - minute],
  );
  assert.equal((await f.scheduler.plan()).planned[0]!.skipped, 1);
  const row = (await all("cron_skips"))[0]!;
  assert.equal(Number(row.first_at_ms), slot - minute);
  assert.equal(Number(row.last_at_ms), slot - minute);
});

test("construction snapshots configuration and definitions before the caller can mutate them", async () => {
  const definitions = [{ owner: "api" as const, cron: "* * * * *" }];
  const limits = { ...cronLimits, maxConcurrent: 1 };
  f = await cronFixture(db, definitions, limits);
  definitions[0]!.cron = "invalid";
  limits.maxConcurrent = 2;
  limits.maxAttempts = 100;
  await ready();
  assert.equal((await all("cron_schedules"))[0]!.cron, "* * * * *");
  const entered = queueDeferred(),
    release = queueDeferred();
  const running = f.scheduler.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  assert.deepEqual(await f.scheduler.run(async () => {}), {
    status: "capacity",
  });
  release.resolve();
  await running;
});
