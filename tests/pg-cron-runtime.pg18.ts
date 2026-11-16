import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import {
  createPgCronScheduler,
  type NativeCronDefinition,
} from "../src/pg-cron.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = readFileSync(
  new URL("../migrations/postgres/0030_cron.sql", import.meta.url),
  "utf8",
);
const definitions: readonly NativeCronDefinition[] = [
  { owner: "api", cron: "* * * * *" },
  { owner: "data", cron: "* * * * *" },
  { owner: "registry", cron: "3,8,13,18,23,28,33,38,43,48,53,58 * * * *" },
];
const limits = {
  maxConcurrent: 2,
  leaseMilliseconds: 60000,
  executionTimeoutMillis: 30000,
  drainTimeoutMillis: 1000,
  maxAttempts: 3,
  historyLimit: 2,
};
let runtime: PgStoreRuntime;
let scheduler: Awaited<ReturnType<typeof createPgCronScheduler>>;
const schedulers: (typeof scheduler)[] = [];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const peer = async () => {
  const value = await createPgCronScheduler(runtime, definitions, limits);
  schedulers.push(value);
  return value;
};

describe("durable PostgreSQL cron scheduler", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    runtime = createPgStoreRuntime({
      connectionString,
      maxConnections: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 5000,
      onIdleError: (error) => {
        throw error;
      },
    });
  });
  beforeEach(async () => {
    await Promise.all(schedulers.splice(0).map((value) => value.close()));
    await control.query("DROP SCHEMA IF EXISTS jobs CASCADE");
    await control.query(migration);
    scheduler = await peer();
  });
  after(async () => {
    await Promise.all(schedulers.map((value) => value.close()));
    await runtime.close();
    try {
      await control.query("DROP SCHEMA IF EXISTS jobs CASCADE");
    } finally {
      await control.end();
    }
  });

  it("creates no schedules until explicit registration, and concurrent planners produce one pending slot", async () => {
    assert.equal(
      (await control.query("SELECT * FROM jobs.cron_schedules")).rows.length,
      0,
    );
    await scheduler.register(0);
    const other = await peer();
    const planned = await Promise.all([scheduler.plan(), other.plan()]);
    assert.equal(planned.flatMap((value) => value.planned).length, 3);
    assert.equal(
      (await control.query("SELECT * FROM jobs.cron_skips")).rows.length,
      3,
    );
    const run = await scheduler.run(async () => ({ ok: false, skipped: true }));
    assert.equal(run.status, "completed");
    const row = (await control.query("SELECT * FROM jobs.cron_runs")).rows[0];
    assert.equal(row.state, "declined");
    assert.equal(row.result_ok, false);
    assert.equal(row.result_skipped, true);
    await assert.rejects(scheduler.register(1), /start boundary differs/);
  });

  it("enforces global capacity across processes and lets pending work run after release", async () => {
    await scheduler.register(0);
    await scheduler.plan();
    const other = await peer();
    const entered = [deferred(), deferred()],
      release = deferred();
    const first = scheduler.run(async () => {
      entered[0]!.resolve();
      await release.promise;
    });
    await entered[0]!.promise;
    const second = other.run(async () => {
      entered[1]!.resolve();
      await release.promise;
    });
    await entered[1]!.promise;
    assert.deepEqual(await other.run(async () => {}), { status: "capacity" });
    assert.equal(
      (
        await control.query(
          "SELECT * FROM jobs.cron_runs WHERE state='running'",
        )
      ).rows.length,
      2,
    );
    release.resolve();
    await Promise.all([first, second]);
    assert.equal((await other.run(async () => {})).status, "completed");
  });

  it("recovers the same expired slot with a new token and fences the original completion", async () => {
    await scheduler.register(0);
    await scheduler.plan();
    // Leave one schedule eligible so the recovery result is unambiguous.
    await control.query(
      "UPDATE jobs.cron_schedules SET pending_at_ms=NULL WHERE owner<>'api'",
    );
    const entered = deferred(),
      release = deferred();
    const original = scheduler.run(async () => {
      entered.resolve();
      await release.promise;
      return { ok: false };
    });
    await entered.promise;
    const old = (await control.query("SELECT * FROM jobs.cron_runs")).rows[0];
    await control.query(
      "UPDATE jobs.cron_runs SET started_at_ms=scheduled_at_ms,lease_until_ms=scheduled_at_ms",
    );
    const other = await peer();
    const recovered = await other.run(async () => ({ ok: true }));
    assert.equal(recovered.status, "completed");
    release.resolve();
    assert.equal((await original).status, "stale");
    const current = (await control.query("SELECT * FROM jobs.cron_runs"))
      .rows[0];
    assert.equal(current.scheduled_at_ms, old.scheduled_at_ms);
    assert.notEqual(current.token, old.token);
    assert.equal(current.attempts, 2);
    assert.equal(current.state, "succeeded");
  });

  it("bounds receipt history and keeps the cumulative skipped count", async () => {
    await scheduler.register(0);
    const now = Number(
      (
        await control.query(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
        )
      ).rows[0].now,
    );
    const slot = Math.floor(now / 60000) * 60000;
    for (let index = 0; index < 5; index++) {
      await control.query(
        "UPDATE jobs.cron_schedules SET cursor_ms=$1,pending_at_ms=$2 WHERE owner='api'",
        [slot - 120001, slot - 180000],
      );
      const result = await scheduler.plan();
      assert.equal(
        result.planned.find((row) => row.owner === "api")!.skipped,
        3,
      );
      await control.query(
        "UPDATE jobs.cron_skips SET through_ms=through_ms-$1 WHERE owner='api' AND through_ms=$2",
        [(index + 1) * 1000, result.throughMs],
      );
    }
    const rows = (
      await control.query("SELECT * FROM jobs.cron_skips WHERE owner='api'")
    ).rows;
    assert.equal(rows.length, 2);
    assert.equal(
      Number(
        (
          await control.query(
            "SELECT skipped_count FROM jobs.cron_schedules WHERE owner='api'",
          )
        ).rows[0].skipped_count,
      ),
      15,
    );
  });

  it("rejects invalid durable states and mismatched policy before scheduling", async () => {
    await assert.rejects(
      createPgCronScheduler(runtime, definitions, {
        ...limits,
        historyLimit: 3,
      }),
      /policy differs/,
    );
    await scheduler.register(0);
    for (const sql of [
      "UPDATE jobs.cron_schedules SET pending_at_ms=1,cursor_ms=0",
      "UPDATE jobs.cron_policy SET max_concurrent=0",
      "UPDATE jobs.cron_policy SET execution_ms=lease_ms",
    ])
      await assert.rejects(control.query(sql));
    await control.query("UPDATE jobs.cron_policy SET max_concurrent=1");
    await assert.rejects(scheduler.plan(), /policy differs/);
  });
});
