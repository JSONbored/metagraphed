import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import type { PgPool, PooledPgOptions } from "../src/pg-pool.ts";
import type { PgSql } from "../src/pg-sql.ts";
import { readStore, type ReadStoreDb } from "../src/read-store.ts";
import type { ProducerStore } from "../src/producer-store.ts";
import { buildTaoUsdSeries, loadTaoUsdSeries } from "../src/tao-usd-series.ts";

const options: PooledPgOptions = {
  connectionString: "postgresql://example/database",
  maxConnections: 2,
  connectionTimeoutMillis: 1000,
  idleTimeoutMillis: 10000,
  statementTimeoutMillis: 2000,
  onIdleError: () => {},
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(config: Partial<PooledPgOptions> = {}) {
  const calls: { text: string; values?: unknown[]; transaction: boolean }[] =
    [];
  let rows: unknown[] = [];
  let wait = Promise.resolve();
  let failure: Error | undefined;
  let factories = 0;
  let connections = 0;
  let releases = 0;
  let ended = 0;
  const query = async (
    text: string,
    values: unknown[] | undefined,
    transaction: boolean,
  ) => {
    calls.push({ text, values, transaction });
    await wait;
    if (failure) throw failure;
    return { rows, rowCount: 1 };
  };
  const pool: PgPool = {
    query: (text, values) => query(text, values, false),
    async connect() {
      connections += 1;
      return {
        query: (text, values) => query(text, values, true),
        release() {
          releases += 1;
        },
        on() {},
        removeListener() {},
      };
    },
    async end() {
      ended += 1;
    },
    on() {},
  };
  const runtime = createPgStoreRuntime({ ...options, ...config }, () => {
    factories += 1;
    return pool;
  });
  return {
    runtime,
    calls,
    setRows(value: unknown[]) {
      rows = value;
    },
    setWait(value: Promise<void>) {
      wait = value;
    },
    setFailure(value: Error | undefined) {
      failure = value;
    },
    factories: () => factories,
    connections: () => connections,
    releases: () => releases,
    ended: () => ended,
  };
}

describe("PostgreSQL store composition", () => {
  test("serves all existing contracts without exposing request-owned close", async () => {
    const f = fixture();
    const sql: PgSql = f.runtime.sql;
    const read: ReadStoreDb = f.runtime.read;
    const producer: Omit<ProducerStore, "close"> = f.runtime.producer;
    const row = { amount: "9007199254740993", absent: null };
    f.setRows([row]);

    assert.deepEqual(await sql<typeof row>`SELECT ${7} AS value`, [row]);
    assert.deepEqual(await sql.unsafe("SELECT ? AS value", [8]), [row]);
    assert.deepEqual(await read.query("SELECT ? AS value", [9]), [row]);
    assert.deepEqual(await read.first("SELECT ? AS value", [10]), row);
    assert.deepEqual(await producer.run("UPDATE items SET value = ?", [11]), {
      changes: 1,
    });
    assert.deepEqual(
      f.calls.map(({ text, values }) => ({ text, values })),
      [
        { text: "SELECT $1 AS value", values: [7] },
        { text: "SELECT $1 AS value", values: [8] },
        { text: "SELECT $1 AS value", values: [9] },
        { text: "SELECT $1 AS value", values: [10] },
        { text: "UPDATE items SET value = $1", values: [11] },
      ],
    );
    assert.equal(f.factories(), 1);
    assert.equal(f.connections(), 0);
    for (const capability of [sql, read, producer]) {
      assert.equal("close" in capability, false);
    }
    assert.equal(f.ended(), 0);
    await f.runtime.close();
    assert.equal(f.ended(), 1);
  });

  test("keeps tagged values out of SQL and preserves their order", async () => {
    const f = fixture();
    const label = "Robert'); DROP TABLE items;--";
    await f.runtime
      .sql`SELECT '?' AS literal WHERE label = ${label} AND id = ${42}`;
    assert.deepEqual(f.calls, [
      {
        text: "SELECT '?' AS literal WHERE label = $1 AND id = $2",
        values: [label, 42],
        transaction: false,
      },
    ]);
    await f.runtime.close();
  });

  test("shares admission across tagged reads, row readers and transactions", async () => {
    const f = fixture();
    const pending = deferred();
    f.setWait(pending.promise);
    const tagged = f.runtime.sql`SELECT ${1}`;
    const read = f.runtime.read.first("SELECT ?", [2]);
    await assert.rejects(
      f.runtime.producer.transaction([
        { text: "INSERT INTO items VALUES (?)", values: [3] },
      ]),
      /at capacity/,
    );
    assert.equal(
      f.connections(),
      0,
      "a rejected transaction acquires no client",
    );
    pending.resolve();
    await Promise.all([tagged, read]);

    assert.deepEqual(
      await f.runtime.producer.transaction([
        { text: "INSERT INTO items VALUES (?)", values: [3] },
        { text: "UPDATE items SET value = ?", values: [4] },
      ]),
      [{ changes: 1 }, { changes: 1 }],
    );
    assert.deepEqual(f.calls.slice(2), [
      {
        text: "BEGIN ISOLATION LEVEL READ COMMITTED",
        values: undefined,
        transaction: true,
      },
      { text: "INSERT INTO items VALUES ($1)", values: [3], transaction: true },
      { text: "UPDATE items SET value = $1", values: [4], transaction: true },
      { text: "COMMIT", values: undefined, transaction: true },
    ]);
    assert.equal(f.connections(), 1);
    assert.equal(f.releases(), 1);
    await f.runtime.close();
  });

  test("composes the existing series loader without changing null-price semantics", async () => {
    const f = fixture();
    const now = 1793668800000;
    f.setRows([
      {
        block_number: 7,
        observed_at: now - 1000,
        usd_per_tao: null,
        price_basis: "insufficient_pools",
        eth_usd: 3000,
        pool_count: 1,
        pools: "[]",
      },
    ]);
    const reader = readStore({}, ["tao_usd_index"], f.runtime.read);
    const rows = await loadTaoUsdSeries(reader, {
      windowHours: 1,
      now: () => now,
    });
    const result = buildTaoUsdSeries(rows, {
      window: "1h",
      now: () => now,
    });
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
    assert.match(f.calls[0].text, /WHERE observed_at >= \$1/);
    assert.deepEqual(f.calls[0].values, [now - 3600000]);
    f.setFailure(new Error("database unavailable"));
    assert.equal(
      await loadTaoUsdSeries(reader, { windowHours: 1 }),
      null,
      "an existing reader keeps its explicit failed-read result",
    );
    await f.runtime.close();
  });

  test("propagates errors through every capability and releases shared admission", async () => {
    const f = fixture({ maxConnections: 1 });
    const failure = new Error("query failed");
    f.setFailure(failure);
    await assert.rejects(f.runtime.sql`SELECT 1`, (error) => error === failure);
    await assert.rejects(
      f.runtime.sql.unsafe("SELECT 2"),
      (error) => error === failure,
    );
    await assert.rejects(
      f.runtime.read.query("SELECT 3"),
      (error) => error === failure,
    );
    await assert.rejects(
      f.runtime.read.first("SELECT 4"),
      (error) => error === failure,
    );
    await assert.rejects(
      f.runtime.producer.run("UPDATE items SET value = 5"),
      (error) => error === failure,
    );
    f.setFailure(undefined);
    f.setRows([]);
    assert.deepEqual(await f.runtime.read.query("SELECT 6"), []);
    assert.equal(await f.runtime.read.first("SELECT 7"), null);
    await f.runtime.close();
  });

  test("owner shutdown drains every capability and closes the shared pool once", async () => {
    const f = fixture({ maxConnections: 3 });
    const pending = deferred();
    f.setWait(pending.promise);
    const tagged = f.runtime.sql`SELECT 1`;
    const read = f.runtime.read.query("SELECT 2");
    const write = f.runtime.producer.run("UPDATE items SET value = 3");
    const closing = f.runtime.close();
    const closingAgain = f.runtime.close();
    assert.equal(closing, closingAgain);
    assert.equal(f.ended(), 0);
    await assert.rejects(f.runtime.sql`SELECT 4`, /closed/);
    await assert.rejects(f.runtime.read.query("SELECT 5"), /closed/);
    await assert.rejects(
      f.runtime.producer.run("UPDATE items SET value = 6"),
      /closed/,
    );
    assert.equal(f.calls.length, 3);
    pending.resolve();
    await Promise.all([tagged, read, write, closing, closingAgain]);
    assert.equal(f.ended(), 1);
  });

  test("separate process runtimes do not share pools or shutdown state", async () => {
    const first = fixture();
    const second = fixture();
    await first.runtime.close();
    second.setRows([{ value: 2 }]);
    assert.deepEqual(await second.runtime.sql`SELECT 2`, [{ value: 2 }]);
    assert.equal(first.ended(), 1);
    assert.equal(second.ended(), 0);
    assert.equal(first.factories(), 1);
    assert.equal(second.factories(), 1);
    await second.runtime.close();
  });
});
