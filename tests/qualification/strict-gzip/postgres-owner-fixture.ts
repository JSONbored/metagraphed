// Synthetic-only fixture. Importing this module starts no service or connection.
// Native execution remains gated by the separately reviewed qualification runner.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const POSTGRES_OWNER = Object.freeze({
  image:
    "docker.io/library/postgres@sha256:66aafa11cf15800a3c94763f7e11d1e7b2e37e5e84bc4ce027cb6e1e4bfaf4df",
  imageIndexDigest:
    "sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826",
  imageConfigDigest:
    "sha256:589f742565e4f6d22149176b032974f55f8201a8a37b71ed587ec5c6902e689f",
  imageSourceCommit: "d43cb516eaae5fe8aa0cac7fc10cd0a27c064adc",
  imageSourceBlob: "9269d7c804a71b8faa8d7926769dbdffe85822ac",
  platform: "linux/amd64",
  packageVersion: "17.11-1.pgdg12+2",
  serverVersionNum: "170011",
  host: "127.0.0.1",
  port: 55432,
  containerPort: 5432,
  publish: "127.0.0.1:55432:5432",
  database: "whole_owner_fixture",
  admin: "qualification_admin",
  adminPassword: "synthetic-qualification-admin-only",
  writer: "qualification_writer",
  writerPassword: "synthetic-qualification-writer-only",
  barrierTimeoutMs: 8000,
  drainTimeoutMs: 10000,
  sourceSchemaSha256:
    "8505b71fd3e300abcfa64d227300c8e4f7a727d656bd60f6553df4b47fc2ca9e",
  miniflareSha256:
    "0e9b02a8f3707b1b9a04a2eb7caea93e8d759c0dcffd84b12a8f1bf26a6830d5",
});

// Deliberately public, disposable fixture values; never use production credentials.
export const QUEUE_HYPERDRIVE_URL =
  "postgresql://qualification_writer:synthetic-qualification-writer-only@127.0.0.1:55432/whole_owner_fixture?sslmode=disable";
export const QUEUE_HYPERDRIVES = Object.freeze({
  HYPERDRIVE: QUEUE_HYPERDRIVE_URL,
});
export const QUEUE_EXTERNAL_SERVICE = Object.freeze({
  name: "hyperdrive:HYPERDRIVE",
  external: { address: "127.0.0.1:55432", tcp: {} },
});

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Reject alternate spelling, defaults, extra query keys, DNS, TLS and mappings. */
export function assertQueueHyperdriveMap(value: unknown): void {
  assert.ok(value !== null && typeof value === "object");
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value), ["HYPERDRIVE"]);
  const descriptor = Object.getOwnPropertyDescriptor(value, "HYPERDRIVE");
  assert.ok(descriptor && "value" in descriptor && descriptor.enumerable);
  assert.deepEqual(value, QUEUE_HYPERDRIVES);
  const url = new URL((value as Record<string, string>).HYPERDRIVE!);
  assert.equal(url.href, QUEUE_HYPERDRIVE_URL);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "55432");
  assert.equal(url.search, "?sslmode=disable");
  assert.equal(url.hash, "");
}

/** Call the actual exported pinned plugin; do not instantiate Miniflare here. */
export async function inspectQueueHyperdriveTransport(plugin: {
  options: { parse(input: unknown): unknown };
  getBindings(options: any): unknown;
  getServices(context: any): unknown;
}): Promise<{ serviceSha256: string }> {
  assertQueueHyperdriveMap(QUEUE_HYPERDRIVES);
  const options = plugin.options.parse({
    hyperdrives: { ...QUEUE_HYPERDRIVES },
  });
  const bindings = plugin.getBindings(options);
  assert.deepEqual(bindings, [
    {
      name: "HYPERDRIVE",
      hyperdrive: {
        designator: { name: "hyperdrive:HYPERDRIVE" },
        database: POSTGRES_OWNER.database,
        user: POSTGRES_OWNER.writer,
        password: POSTGRES_OWNER.writerPassword,
        scheme: "postgresql",
      },
    },
  ]);
  const services = await plugin.getServices({
    options,
    hyperdriveProxyController: {
      createProxyServer() {
        throw new Error("Qualification forbids Hyperdrive proxy/TLS");
      },
    },
  });
  assert.deepEqual(services, [QUEUE_EXTERNAL_SERVICE]);
  return { serviceSha256: sha256(JSON.stringify(services)) };
}

export const QUEUE_TABLES = [
  "chain_detail_extrinsics",
  "chain_detail_chain_events",
  "chain_detail_account_events",
  "chain_detail_blocks",
  "lane_health",
] as const;

/** Extract unchanged source DDL, including every relevant index and PK. */
export function queueSchemaStatements(schema: string): string[] {
  assert.equal(sha256(schema), POSTGRES_OWNER.sourceSchemaSha256);
  const table = `(?:${QUEUE_TABLES.join("|")})`;
  const patterns = [
    new RegExp(`CREATE TABLE public\\.${table} \\([\\s\\S]*?\\n\\);`, "g"),
    new RegExp(`ALTER TABLE ONLY public\\.${table}\\n[\\s\\S]*?;`, "g"),
    new RegExp(
      `CREATE (?:UNIQUE )?INDEX [^;]+ ON public\\.${table} [^;]+;`,
      "g",
    ),
  ];
  const groups = patterns.map((pattern) =>
    [...schema.matchAll(pattern)].map((match) => match[0]),
  );
  assert.deepEqual(
    groups.map((group) => group.length),
    [5, 4, 11],
  );
  return groups.flat();
}

export interface QueryClient {
  connect(): Promise<void>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, any>[] }>;
  end(): Promise<void>;
}
export interface QueueExpectedFamilies {
  blockRows: Record<string, unknown>[];
  extrinsicRows: Record<string, unknown>[];
  chainEventRows: Record<string, unknown>[];
  accountEventRows: Record<string, unknown>[];
}
export interface QueueBlockedOperation {
  owner: "event-a" | "event-b";
  blockNumber: number;
  pid: number;
  blockerPid: number;
  transactionId: string;
  querySha256: string;
}
export interface QueueBarrierReceipt {
  observedMonotonicMs: number;
  operations: QueueBlockedOperation[];
}

// Pin the source writer's one-row first statement. The owner test additionally
// compares this with actual buildPgUpsert(...CHAIN_DETAIL_EXTRINSIC_COLUMNS...).
export const QUEUE_FIRST_QUERY =
  "INSERT INTO chain_detail_extrinsics (block_number, extrinsic_index, extrinsic_hash, signer, call_module, call_function, success, fee_tao, tip_tao, call_args, observed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (block_number, extrinsic_index) DO UPDATE SET extrinsic_hash = EXCLUDED.extrinsic_hash, signer = EXCLUDED.signer, call_module = EXCLUDED.call_module, call_function = EXCLUDED.call_function, success = EXCLUDED.success, fee_tao = EXCLUDED.fee_tao, tip_tao = EXCLUDED.tip_tao, call_args = EXCLUDED.call_args, observed_at = EXCLUDED.observed_at";

export const QUEUE_WAITING_SQL = `
SELECT a.pid, a.query, a.state, a.wait_event_type, a.wait_event,
       w.transactionid::text AS transaction_id, h.pid AS blocker_pid,
       pg_blocking_pids(a.pid) AS blockers
FROM pg_stat_activity a
JOIN pg_locks w ON w.pid = a.pid AND w.locktype = 'transactionid'
  AND w.mode = 'ShareLock' AND NOT w.granted
JOIN pg_locks h ON h.locktype = 'transactionid' AND h.transactionid = w.transactionid
  AND h.mode = 'ExclusiveLock' AND h.granted
WHERE a.datname = $1 AND a.usename = $2
ORDER BY a.pid, h.pid`;

/** Pure witness rejection: two sessions alone, wrong query or wrong lock fails. */
export function validateQueueWaiters(
  rows: Record<string, any>[],
  holders: readonly { block: number; pid: number; transactionId: string }[],
): QueueBlockedOperation[] {
  assert.equal(holders.length, 2);
  assert.notEqual(holders[0]!.block, holders[1]!.block);
  assert.notEqual(holders[0]!.pid, holders[1]!.pid);
  assert.notEqual(holders[0]!.transactionId, holders[1]!.transactionId);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0]!.pid, rows[1]!.pid);
  return holders.map((holder, index) => {
    const matches = rows.filter((row) => row.blocker_pid === holder.pid);
    assert.equal(matches.length, 1);
    const row = matches[0]!;
    assert.ok(Number.isInteger(row.pid) && row.pid > 0);
    assert.ok(!holders.some((other) => other.pid === row.pid));
    assert.equal(row.transaction_id, holder.transactionId);
    assert.equal(row.query, QUEUE_FIRST_QUERY);
    assert.equal(row.state, "active");
    assert.equal(row.wait_event_type, "Lock");
    assert.equal(row.wait_event, "transactionid");
    assert.deepEqual(row.blockers, [holder.pid]);
    return {
      owner: index === 0 ? "event-a" : "event-b",
      blockNumber: holder.block,
      pid: row.pid,
      blockerPid: holder.pid,
      transactionId: holder.transactionId,
      querySha256: sha256(row.query),
    };
  });
}

export interface QueueBarrier {
  waitForTwo(eventsStillPending: () => boolean): Promise<QueueBarrierReceipt>;
  release(): Promise<void>;
  verifyRows(expected: QueueExpectedFamilies): Promise<{
    rowCounts: number[];
    contentSha256: string;
    laneHealthRows: number;
  }>;
  drain(): Promise<{ remainingWriterSessions: 0; stableZeroSamples: 2 }>;
  close(): Promise<void>;
}

/** Requires an already reviewed/running disposable service. Never starts one. */
export async function armQueueBarrier(
  blockA: number,
  blockB: number,
  sourceRoot: string = process.cwd(),
): Promise<QueueBarrier> {
  for (const block of [blockA, blockB])
    assert.ok(Number.isInteger(block) && block > 0 && block <= 2_147_483_647);
  assert.notEqual(blockA, blockB);
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const ddl = queueSchemaStatements(
    readFileSync(join(sourceRoot, "db/schema.sql"), "utf8"),
  );
  const require = createRequire(join(sourceRoot, "package.json"));
  const packagePath = require.resolve("pg/package.json");
  const pgPackage = JSON.parse(readFileSync(packagePath, "utf8"));
  assert.equal(pgPackage.name, "pg");
  assert.equal(pgPackage.version, "8.22.0");
  // Actual pg, never a clientFactory, alias, mock, or substituted business writer.
  const pg = await import(require.resolve("pg"));
  const Client = pg.Client ?? pg.default?.Client;
  assert.equal(typeof Client, "function");
  const clients: QueryClient[] = [];
  let held = false;
  const connect = async (name: string): Promise<QueryClient> => {
    const client: QueryClient = new Client({
      host: POSTGRES_OWNER.host,
      port: POSTGRES_OWNER.port,
      database: POSTGRES_OWNER.database,
      user: POSTGRES_OWNER.admin,
      password: POSTGRES_OWNER.adminPassword,
      ssl: false,
      application_name: name,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
      lock_timeout: 3000,
      idle_in_transaction_session_timeout: 20000,
    });
    clients.push(client);
    await client.connect();
    return client;
  };
  const release = async () => {
    if (!held) return;
    const results = await Promise.allSettled(
      clients.slice(1).map((client) => client.query("ROLLBACK")),
    );
    held = false;
    const failed = results.filter((result) => result.status === "rejected");
    assert.equal(failed.length, 0, "Controller lock release failed");
  };
  const close = async () => {
    let releaseError: unknown;
    try {
      await release();
    } catch (error) {
      releaseError = error;
    }
    const ended = await Promise.allSettled(
      clients.map((client) => client.end()),
    );
    if (releaseError) throw releaseError;
    assert.equal(
      ended.filter((result) => result.status === "rejected").length,
      0,
      "Host PostgreSQL connection teardown failed",
    );
  };
  try {
    const observer = await connect("qualification-observer");
    const version = await observer.query(
      "SELECT current_database() AS database, current_user AS username, current_setting('server_version_num') AS version",
    );
    assert.deepEqual(version.rows, [
      {
        database: POSTGRES_OWNER.database,
        username: POSTGRES_OWNER.admin,
        version: POSTGRES_OWNER.serverVersionNum,
      },
    ]);
    // A fresh dedicated service/database is mandatory. Never truncate or adopt an existing DB.
    const existing = await observer.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    assert.equal(existing.rows.length, 0, "Fixture database is not empty");
    for (const statement of ddl) await observer.query(statement);
    await observer.query(
      "CREATE ROLE qualification_writer LOGIN PASSWORD 'synthetic-qualification-writer-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 8",
    );
    await observer.query(
      "GRANT CONNECT ON DATABASE whole_owner_fixture TO qualification_writer",
    );
    await observer.query(
      "GRANT USAGE ON SCHEMA public TO qualification_writer",
    );
    await observer.query(
      "GRANT SELECT, INSERT, UPDATE ON chain_detail_extrinsics, chain_detail_chain_events, chain_detail_account_events, chain_detail_blocks TO qualification_writer",
    );
    await observer.query(
      "GRANT SELECT, INSERT, DELETE ON lane_health TO qualification_writer",
    );
    await observer.query(
      "ALTER ROLE qualification_writer SET statement_timeout = '20000ms'",
    );
    await observer.query(
      "ALTER ROLE qualification_writer SET lock_timeout = '15000ms'",
    );
    await observer.query(
      "ALTER ROLE qualification_writer SET idle_in_transaction_session_timeout = '20000ms'",
    );
    await observer.query(
      "INSERT INTO chain_detail_extrinsics (block_number, extrinsic_index, call_function, observed_at) VALUES ($1, 0, 'seed-before-event-a', 1), ($2, 0, 'seed-before-event-b', 1)",
      [blockA, blockB],
    );
    const holders: { block: number; pid: number; transactionId: string }[] = [];
    held = true;
    for (const [index, block] of [blockA, blockB].entries()) {
      const controller = await connect(
        index === 0 ? "qualification-lock-a" : "qualification-lock-b",
      );
      await controller.query("BEGIN");
      const locked = await controller.query(
        "SELECT block_number, extrinsic_index FROM chain_detail_extrinsics WHERE block_number = $1 AND extrinsic_index = 0 FOR UPDATE",
        [block],
      );
      assert.deepEqual(locked.rows, [
        { block_number: block, extrinsic_index: 0 },
      ]);
      const identity = await controller.query(
        "SELECT pg_backend_pid() AS pid, pg_current_xact_id()::text AS transaction_id",
      );
      holders.push({
        block,
        pid: identity.rows[0]!.pid,
        transactionId: identity.rows[0]!.transaction_id,
      });
    }
    return {
      async waitForTwo(eventsStillPending) {
        const deadline = performance.now() + POSTGRES_OWNER.barrierTimeoutMs;
        while (performance.now() < deadline) {
          assert.ok(
            eventsStillPending(),
            "An owner settled before both writer operations blocked",
          );
          const result = await observer.query(QUEUE_WAITING_SQL, [
            POSTGRES_OWNER.database,
            POSTGRES_OWNER.writer,
          ]);
          if (result.rows.length >= 2) {
            const operations = validateQueueWaiters(result.rows, holders);
            assert.ok(
              eventsStillPending(),
              "An owner settled before overlap observation",
            );
            return { observedMonotonicMs: performance.now(), operations };
          }
          await delay(25);
        }
        throw new Error(
          "Two distinct real owner writes did not block before timeout",
        );
      },
      release,
      async verifyRows(expected) {
        assert.equal(held, false, "Release the outside-owner barrier first");
        const pairs = [
          ["chain_detail_blocks", "blockRows", "block_number"],
          [
            "chain_detail_extrinsics",
            "extrinsicRows",
            "block_number, extrinsic_index",
          ],
          [
            "chain_detail_chain_events",
            "chainEventRows",
            "block_number, event_index",
          ],
          [
            "chain_detail_account_events",
            "accountEventRows",
            "block_number, event_index",
          ],
        ] as const;
        const durable: unknown[] = [];
        for (const [table, family, order] of pairs) {
          const result = await observer.query(
            `SELECT * FROM ${table} ORDER BY ${order}`,
          );
          assert.equal(result.rows.length, expected[family].length);
          const columns = Object.keys(result.rows[0] ?? {});
          assert.ok(columns.length > 0);
          const normalize = (row: Record<string, unknown>) =>
            Object.fromEntries(
              columns.map((column) => {
                let value = row[column] ?? null;
                if (
                  ["observed_at", "synced_at"].includes(column) &&
                  value !== null
                ) {
                  value = Number(value);
                  assert.ok(
                    Number.isSafeInteger(value),
                    "Unsafe database timestamp",
                  );
                }
                if (
                  ["success", "economics_complete"].includes(column) &&
                  value !== null
                )
                  value = Boolean(value);
                if (column === "subnet_ids" && typeof value === "string")
                  value = JSON.parse(value);
                return [column, value];
              }),
            );
          const actual = result.rows.map(normalize);
          const wanted = expected[family]
            .map(normalize)
            .sort(
              (left, right) =>
                Number(left.block_number) - Number(right.block_number) ||
                Number(left.extrinsic_index ?? left.event_index ?? 0) -
                  Number(right.extrinsic_index ?? right.event_index ?? 0),
            );
          assert.deepEqual(actual, wanted);
          durable.push(actual);
        }
        const health = await observer.query(
          "SELECT lane, verdict, detail FROM lane_health ORDER BY checked_at",
        );
        // Success verdicts coalesce in the unchanged owner; a concurrent first pair
        // can record more than one. The durable business rows prove every message.
        assert.ok(
          health.rows.length >= 1 &&
            health.rows.length <= expected.blockRows.length,
        );
        assert.ok(
          health.rows.every(
            (row) => row.lane === "neon:chain-detail" && row.verdict === "ok",
          ),
        );
        return {
          rowCounts: pairs.map(([, family]) => expected[family].length),
          contentSha256: sha256(JSON.stringify(durable)),
          laneHealthRows: health.rows.length,
        };
      },
      async drain() {
        const deadline = performance.now() + POSTGRES_OWNER.drainTimeoutMs;
        let zeroSamples = 0;
        while (performance.now() < deadline) {
          const result = await observer.query(
            "SELECT pid, state FROM pg_stat_activity WHERE datname = $1 AND usename = $2",
            [POSTGRES_OWNER.database, POSTGRES_OWNER.writer],
          );
          zeroSamples = result.rows.length === 0 ? zeroSamples + 1 : 0;
          if (zeroSamples === 2)
            return { remainingWriterSessions: 0, stableZeroSamples: 2 };
          await delay(50);
        }
        throw new Error(
          "Real writer sessions remained after native event drain",
        );
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}

/** Observe the actual pinned plugin invocation that feeds this workerd config.
 * The returned object and caller context are forwarded unchanged. Restoration
 * never erases a recorded failure or manufactures an observed invocation. */
export function observeActualQueueTransport(plugin: {
  getServices: (context: any) => unknown;
}) {
  const original = plugin.getServices;
  let calls = 0,
    failed = false,
    restored = false;
  const wrapped = async function (this: unknown, context: any) {
    try {
      assert.equal(restored, false);
      assert.equal(calls, 0);
      assert.ok(context && context.options && context.options.hyperdrives);
      assert.deepEqual(Object.keys(context.options.hyperdrives), [
        "HYPERDRIVE",
      ]);
      const url = context.options.hyperdrives.HYPERDRIVE;
      assert.ok(url instanceof URL);
      assert.equal(url.href, QUEUE_HYPERDRIVE_URL);
      const result = await Reflect.apply(original, this, [context]);
      assert.deepEqual(result, [QUEUE_EXTERNAL_SERVICE]);
      calls++;
      return result;
    } catch {
      failed = true;
      throw new Error("Actual native PostgreSQL transport refused");
    }
  };
  plugin.getServices = wrapped;
  return {
    assertObserved() {
      assert.equal(failed, false);
      assert.equal(calls, 1);
      return {
        calls: 1,
        serviceSha256: sha256(JSON.stringify([QUEUE_EXTERNAL_SERVICE])),
      };
    },
    restore() {
      assert.equal(plugin.getServices, wrapped);
      plugin.getServices = original;
      restored = true;
    },
  };
}
