import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createPgRpcUsageStore } from "../src/pg-rpc-usage.ts";
import { createPgRpcUsageReader } from "../src/pg-rpc-usage-reader.ts";
import type { RpcUsageEvent } from "../src/rpc-usage-capture.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const runtime = createPgStoreRuntime({
  connectionString,
  maxConnections: 1,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
});
const stamp = 1790000000000;
const options = {
  maxPending: 20,
  maxPendingBytes: 16384,
  batchSize: 2,
  retentionDays: 31,
  executionTimeoutMillis: 5000,
  drainTimeoutMillis: 5000,
  now: () => stamp,
};
const event: RpcUsageEvent = {
  pool: "public",
  network: "finney",
  endpointId: "a\0b\ud800",
  provider: null,
  ok: true,
  status: 200,
  attempts: 1,
  latencyMs: 10,
  cache: "miss",
};
let ownSchema = false;

describe("native RPC usage on PostgreSQL 18", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    ownSchema = !(
      await control.query("SELECT 1 FROM pg_namespace WHERE nspname='app'")
    ).rowCount;
    await control.query("CREATE SCHEMA IF NOT EXISTS app");
    for (const name of [
      "0038_rpc_usage.sql",
      "0042_rpc_usage_archive.sql",
      "0043_rpc_usage_archive_prune.sql",
    ])
      await control.query(
        readFileSync(
          new URL(`../migrations/postgres/${name}`, import.meta.url),
          "utf8",
        ),
      );
  });
  after(async () => {
    await runtime.close();
    await control.query("DROP FUNCTION app.rpc_usage_prune(bigint,integer)");
    await control.query(
      "DROP FUNCTION app.rpc_usage_record_archive(date,bigint,text,text,text,bigint)",
    );
    await control.query("DROP FUNCTION app.rpc_usage_day_fingerprint(date)");
    await control.query(
      "DROP TABLE app.rpc_usage_prune_state,app.rpc_usage_archive_days,app.rpc_usage_events",
    );
    if (ownSchema) await control.query("DROP SCHEMA app");
    await control.end();
  });

  it("preserves weighted latency, exact encoded identities, and public/fullnode separation", async () => {
    const store = createPgRpcUsageStore(runtime, options);
    assert.equal(store.record(event), true);
    assert.equal(
      store.record({
        ...event,
        latencyMs: 30,
        ok: false,
        attempts: 2,
        cache: "hit",
      }),
      true,
    );
    assert.equal(
      store.record({ ...event, pool: "fullnode", latencyMs: 10000 }),
      true,
    );
    await store.close();
    await control.query(
      "UPDATE app.rpc_usage_events SET sample_weight=2 WHERE pool='public'",
    );
    const result = await store.load("7d", stamp);
    assert.deepEqual(result?.summary, {
      total_requests: 4,
      ok_requests: 2,
      error_requests: 2,
      error_rate: 0.5,
      failover_requests: 2,
      failover_rate: 0.5,
      cache_hits: 2,
      cache_hit_rate: 0.5,
      latency_ms: { p50: 20, p95: 30, avg: 20 },
    });
    assert.deepEqual(result?.endpoints, [
      {
        rank: 1,
        endpoint_id: event.endpointId,
        provider: null,
        requests: 4,
        ok_requests: 2,
        error_rate: 0.5,
        avg_latency_ms: 20,
      },
    ]);
    assert.equal(await store.load("7d", stamp - 1), null);
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS count FROM app.rpc_usage_events",
        )
      ).rows[0].count,
      3,
    );
  });

  it("replays an uncertain committed batch without duplicating rows", async () => {
    await control.query("TRUNCATE app.rpc_usage_events");
    let fail = true;
    const store = createPgRpcUsageStore(
      {
        transaction: async (fn, config) => {
          const result = await runtime.transaction(fn, config);
          if (fail) {
            fail = false;
            throw new Error("simulated commit acknowledgement loss");
          }
          return result;
        },
      },
      options,
    );
    store.record(event);
    store.record(event);
    await assert.rejects(store.flush(), /acknowledgement loss/);
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS count FROM app.rpc_usage_events",
        )
      ).rows[0].count,
      2,
    );
    await store.flush();
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS count FROM app.rpc_usage_events",
        )
      ).rows[0].count,
      2,
    );
    assert.equal(store.stats().persisted, 2);
    await store.close();
  });

  it("rolls back partial writes and preserves the queue for a later flush", async () => {
    await control.query("TRUNCATE app.rpc_usage_events");
    let fail = true;
    const store = createPgRpcUsageStore(
      {
        transaction: (fn, config) =>
          runtime.transaction(async (scope) => {
            const result = await fn(scope);
            if (fail) throw new Error("late write failure");
            return result;
          }, config),
      },
      options,
    );
    store.record(event);
    await assert.rejects(store.flush(), /late write failure/);
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS count FROM app.rpc_usage_events",
        )
      ).rows[0].count,
      0,
    );
    assert.equal(store.stats().pending, 1);
    fail = false;
    await store.close();
    assert.equal((await store.load("7d", stamp))?.observed_at, stamp);
  });

  it("requires archive receipts for public retention and preserves fullnode policy", async () => {
    await control.query("TRUNCATE app.rpc_usage_events");
    const old = createPgRpcUsageStore(runtime, {
      ...options,
      now: () => stamp - 32 * 86400000,
    });
    old.record({ ...event, endpointId: "node" });
    old.record({ ...event, pool: "fullnode" });
    await old.close();
    const fresh = createPgRpcUsageStore(runtime, options);
    fresh.record(event);
    await fresh.flush();
    assert.equal(await fresh.prune(), 1); // Only the expired fullnode event.
    assert.equal(await fresh.prune(), 0); // Public source has no archive receipt.
    const oldDay = new Date(stamp - 32 * 86400000).toISOString().slice(0, 10);
    const source = (
      await control.query("SELECT * FROM app.rpc_usage_day_fingerprint($1)", [
        oldDay,
      ])
    ).rows[0];
    await control.query(
      "SELECT app.rpc_usage_record_archive($1,$2,$3,$4,$5,$6)",
      [
        oldDay,
        source.source_rows,
        source.source_sha256,
        "11111111-2222-3333-4444-555555555555",
        "123",
        stamp,
      ],
    );
    assert.equal(await fresh.prune(), 1);
    assert.equal(await fresh.prune(), 0);
    await assert.rejects(
      control.query("UPDATE app.rpc_usage_events SET latency_ms='NaN'"),
    );
    await assert.rejects(
      control.query("UPDATE app.rpc_usage_events SET sample_weight=0"),
    );
    assert.equal((await fresh.load("30d", stamp))?.observed_at, stamp);
    await fresh.close();
  });

  it("all rollups share one snapshot while another connection commits a new event", async () => {
    await control.query("TRUNCATE app.rpc_usage_events");
    const store = createPgRpcUsageStore(runtime, options);
    store.record(event);
    await store.flush();
    let insert = true;
    const read = createPgRpcUsageReader({
      transaction: (fn, config) =>
        runtime.transaction(
          (scope) =>
            fn({
              ...scope,
              async first<Row>(sql: string, values?: unknown[]) {
                const row = await scope.first<Row>(sql, values);
                if (insert) {
                  insert = false;
                  await control.query(
                    `INSERT INTO app.rpc_usage_events SELECT gen_random_uuid(),occurred_at,pool,network_key,endpoint_key,provider_key,cache,ok,attempts,latency_ms,status,sample_weight FROM app.rpc_usage_events`,
                  );
                }
                return row;
              },
            }),
          config,
        ),
    });
    const concurrent = await read("7d", stamp);
    assert.equal(
      (concurrent?.summary as { total_requests: number }).total_requests,
      1,
    );
    // A fresh reader includes both; the first reader above completed without a
    // latency census mismatch despite the insert between its first two queries.
    assert.equal(
      ((await store.load("7d", stamp))?.summary as { total_requests: number })
        .total_requests,
      2,
    );
    await store.close();
  });
});
