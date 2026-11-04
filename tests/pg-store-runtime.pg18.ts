import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import {
  createPgStoreRuntime,
  type PgStoreRuntime,
} from "../src/pg-store-runtime.ts";
import { buildTaoUsdSeries, loadTaoUsdSeries } from "../src/tao-usd-series.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

// Real-engine qualification for #12978. This entry point requires the disposable
// CI database. A missing
// service or a connection string for any other database fails before connecting.
const fixtureUrl = pg18FixtureUrl();

const control = new Client({
  connectionString: fixtureUrl.toString(),
  application_name: "pg18-fixture-control",
  connectionTimeoutMillis: 2_000,
  statement_timeout: 2_000,
  query_timeout: 2_000,
});
const fixtureSchema = "pg18_runtime_fixture";
let ownsSchema = false;
let nextRuntime = 0;

function runtime(maxConnections = 2, statementTimeoutMillis = 5_000) {
  const applicationName = `pg18-runtime-${process.pid}-${++nextRuntime}`;
  const connection = new URL(fixtureUrl);
  connection.searchParams.set("application_name", applicationName);
  connection.searchParams.set("options", `-c search_path=${fixtureSchema}`);
  const idleErrors: Error[] = [];
  return {
    applicationName,
    idleErrors,
    store: createPgStoreRuntime({
      connectionString: connection.toString(),
      maxConnections,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 1_000,
      statementTimeoutMillis,
      onIdleError: (error) => idleErrors.push(error),
    }),
  };
}

async function blockedQueries(applicationName: string, expected: number) {
  // Observe the actual server wait before testing admission or shutdown.
  const deadline = Date.now() + 2_000;
  for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt += 1) {
    const result = await control.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM pg_stat_activity " +
        "WHERE application_name = $1 AND wait_event_type = 'Lock'",
      [applicationName],
    );
    if (Number(result.rows[0].count) === expected) return;
    await delay(50);
  }
  assert.fail(`expected ${expected} fixture queries waiting for the held lock`);
}

async function connections(applicationName: string) {
  const result = await control.query<{ count: string | number }>(
    "SELECT count(*) AS count FROM pg_stat_activity WHERE application_name = $1",
    [applicationName],
  );
  return Number(result.rows[0].count);
}

async function close(store: PgStoreRuntime, idleErrors: Error[]) {
  await store.close();
  assert.deepEqual(
    idleErrors,
    [],
    "fixture pool reported an idle connection error",
  );
}

describe("pooled store against PostgreSQL 18.6", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    const version = await control.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    assert.equal(version.rows[0].server_version_num, "180006");
    await control.query("CREATE SCHEMA pg18_runtime_fixture");
    ownsSchema = true;
    await control.query("SET search_path TO pg18_runtime_fixture");
    await control.query(
      "CREATE TABLE fixture_values (" +
        "id integer PRIMARY KEY, wide bigint, amount numeric, body bytea, note text)",
    );
    await control.query(
      "CREATE TABLE fixture_rollback (id integer PRIMARY KEY)",
    );
    await control.query(
      "CREATE TABLE fixture_contention (id integer PRIMARY KEY)",
    );
    await control.query(
      "CREATE TABLE tao_usd_index (block_number bigint PRIMARY KEY, observed_at bigint, " +
        "usd_per_tao double precision, price_basis text, eth_usd double precision, " +
        "pool_count integer, pools text)",
    );
  });

  after(async () => {
    try {
      if (ownsSchema)
        await control.query("DROP SCHEMA pg18_runtime_fixture CASCADE");
    } finally {
      await control.end();
    }
  });

  it("preserves exact values through tagged SQL, readers and writes", async () => {
    const { store, idleErrors } = runtime();
    try {
      const amount = "12345678901234567890.00000000000000000001";
      const bytes = Buffer.from([0, 255, 1, 127]);
      assert.deepEqual(
        await store.producer.run(
          "INSERT INTO fixture_values (id,wide,amount,body,note) VALUES (?,?,?,?,?)",
          [1, "9007199254740993", amount, bytes, "λ'\n"],
        ),
        { changes: 1 },
      );
      const rows = await store.sql<{
        id: number;
        wide: string;
        amount: string;
        body: Buffer;
        note: string;
      }>`SELECT id,wide,amount,body,note FROM fixture_values WHERE id = ${1}`;
      assert.deepEqual(rows, [
        { id: 1, wide: "9007199254740993", amount, body: bytes, note: "λ'\n" },
      ]);
      assert.deepEqual(
        await store.read.first<{ small: number; absent: null }>(
          "SELECT ?::bigint AS small, NULL::text AS absent",
          [42],
        ),
        { small: 42, absent: null },
      );
      assert.equal(
        await store.read.first(
          "SELECT id FROM fixture_values WHERE id = ?",
          [99],
        ),
        null,
      );
      assert.deepEqual(
        await store.sql.unsafe(
          "SELECT id FROM fixture_values WHERE id = ?",
          [99],
        ),
        [],
      );
    } finally {
      await close(store, idleErrors);
    }
  });

  it("rolls back a failed batch and reuses its connection for a later transaction", async () => {
    const { store, idleErrors } = runtime(1);
    try {
      const backendBefore = await store.read.first<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await assert.rejects(
        store.producer.transaction([
          { text: "INSERT INTO fixture_rollback VALUES (?)", values: [1] },
          { text: "INSERT INTO fixture_rollback VALUES (?)", values: [1] },
          { text: "INSERT INTO fixture_rollback VALUES (?)", values: [2] },
        ]),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23505");
          return true;
        },
      );
      assert.deepEqual(
        await store.read.query("SELECT id FROM fixture_rollback"),
        [],
      );
      assert.deepEqual(
        await store.read.first<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        ),
        backendBefore,
      );
      assert.deepEqual(
        await store.producer.transaction([
          { text: "INSERT INTO fixture_rollback VALUES (?)", values: [3] },
          {
            text: "UPDATE fixture_rollback SET id = ? WHERE id = ?",
            values: [4, 3],
          },
        ]),
        [{ changes: 1 }, { changes: 1 }],
      );
      assert.deepEqual(
        await store.read.query("SELECT id FROM fixture_rollback"),
        [{ id: 4 }],
      );
    } finally {
      await close(store, idleErrors);
    }
  });

  it("shares real connection admission between tagged SQL, readers and a transaction", async () => {
    const { store, applicationName, idleErrors } = runtime(2);
    const key = 1297301;
    await control.query("SELECT pg_advisory_lock($1)", [key]);
    const read = store.sql`SELECT pg_advisory_xact_lock(${key})`;
    const write = store.producer.transaction([
      { text: "SELECT pg_advisory_xact_lock(?)", values: [key] },
      { text: "INSERT INTO fixture_contention VALUES (?)", values: [1] },
    ]);
    const finished = Promise.allSettled([read, write]);
    try {
      await blockedQueries(applicationName, 2);
      assert.equal(await connections(applicationName), 2);
      await assert.rejects(store.read.first("SELECT 1"), /at capacity/);
    } finally {
      try {
        await control.query("SELECT pg_advisory_unlock($1)", [key]);
      } finally {
        const outcomes = await finished;
        await close(store, idleErrors);
        assert.deepEqual(
          outcomes.map((outcome) => outcome.status),
          ["fulfilled", "fulfilled"],
        );
      }
    }
    assert.deepEqual(
      (await control.query("SELECT id FROM fixture_contention")).rows,
      [{ id: 1 }],
    );
  });

  it("releases admission after a server-side statement timeout", async () => {
    const { store, idleErrors } = runtime(1, 30);
    try {
      await assert.rejects(
        store.read.query("SELECT pg_sleep(1)"),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "57014");
          return true;
        },
      );
      assert.deepEqual(await store.read.first("SELECT 7::integer AS value"), {
        value: 7,
      });
    } finally {
      await close(store, idleErrors);
    }
  });

  it("drains an admitted query, rejects new work and closes its real connections", async () => {
    const { store, applicationName, idleErrors } = runtime(1);
    const key = 1297302;
    await control.query("SELECT pg_advisory_lock($1)", [key]);
    const pending = store.read.query("SELECT pg_advisory_xact_lock(?)", [key]);
    const finished = Promise.allSettled([pending]);
    let closing: Promise<void> | undefined;
    try {
      await blockedQueries(applicationName, 1);
      closing = store.close();
      assert.equal(store.close(), closing);
      let closed = false;
      void closing.then(
        () => {
          closed = true;
        },
        () => {},
      );
      await assert.rejects(
        store.producer.run("INSERT INTO fixture_contention VALUES (2)"),
        /closed/,
      );
      await assert.rejects(store.sql`SELECT 1`, /closed/);
      assert.equal(await connections(applicationName), 1);
      assert.equal(closed, false);
    } finally {
      try {
        await control.query("SELECT pg_advisory_unlock($1)", [key]);
      } finally {
        const outcomes = await finished;
        await (closing ?? store.close());
        assert.deepEqual(
          outcomes.map((outcome) => outcome.status),
          ["fulfilled"],
        );
      }
    }
    // Pool.end waits for client socket closure; PostgreSQL may remove the
    // backend from pg_stat_activity a moment after receiving termination.
    // Keep the same zero-backend assertion with a bounded server readback.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await connections(applicationName)) === 0) break;
      await delay(10);
    }
    assert.equal(await connections(applicationName), 0);
    assert.deepEqual(idleErrors, []);
  });

  it("serves the existing TAO/USD reader with the latest unpriced observation intact", async () => {
    const { store, idleErrors } = runtime();
    const now = 1793668800000;
    try {
      await store.producer.run(
        "INSERT INTO tao_usd_index VALUES (?,?,?,?,?,?,?)",
        [7, now - 1000, null, "insufficient_pools", 3000, 1, "[]"],
      );
      const rows = await loadTaoUsdSeries(store.read, {
        windowHours: 1,
        now: () => now,
      });
      const result = buildTaoUsdSeries(rows, { window: "1h", now: () => now });
      assert.equal(result.point_count, 1);
      assert.equal(result.priced_point_count, 0);
      assert.deepEqual(result.latest, {
        usd_per_tao: null,
        price_basis: "insufficient_pools",
        eth_usd: 3000,
        block_number: 7,
        observed_at: new Date(now - 1000).toISOString(),
        pool_count: 1,
        pools: [],
      });
    } finally {
      await close(store, idleErrors);
    }
  });
});
