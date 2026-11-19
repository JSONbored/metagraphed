// Connects only when explicitly called by the reviewed native phase. Never launches
// services, changes authentication, creates roles, commits seeds or deletes rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  POSTGRES_OWNER,
  QUEUE_TABLES,
  queueSchemaStatements,
  sha256,
  type QueryClient,
  type QueueExpectedFamilies,
} from "./postgres-owner-fixture.ts";
import {
  FAILURE_WAIT_SQL,
  FAILURE_CANCEL_SQL,
  validateFailureWaiter,
  assertSameFailureWaiter,
  cancelParameters,
  assertCancellationResult,
  type FailureHolder,
  type FailureWaiter,
} from "./failure-postgres-policy.ts";
import { withinOwnerDeadline } from "./owner-deadline.ts";

export const FAILURE_TIME = 1_780_000_000_000;
export const FAILURE_FAMILIES = [
  ["chain_detail_blocks", "blockRows", "block_number"],
  ["chain_detail_extrinsics", "extrinsicRows", "block_number, extrinsic_index"],
  ["chain_detail_chain_events", "chainEventRows", "block_number, event_index"],
  [
    "chain_detail_account_events",
    "accountEventRows",
    "block_number, event_index",
  ],
] as const;
export function emptyFailureFamilies(): QueueExpectedFamilies {
  return {
    blockRows: [],
    extrinsicRows: [],
    chainEventRows: [],
    accountEventRows: [],
  };
}
export function combineFailureFamilies(
  ...inputs: QueueExpectedFamilies[]
): QueueExpectedFamilies {
  const result = emptyFailureFamilies();
  for (const input of inputs)
    for (const key of Object.keys(result) as (keyof QueueExpectedFamilies)[])
      result[key].push(...input[key]);
  return result;
}
export function failureFamilies(block: number): QueueExpectedFamilies {
  assert.ok(Number.isSafeInteger(block) && block > 0 && block <= 2_147_483_647);
  return {
    blockRows: [
      {
        block_number: block,
        block_hash: `0x${block.toString(16).padStart(64, "0")}`,
        spec_version: 441,
        extrinsic_count: 1,
        chain_event_count: 1,
        account_event_count: 1,
        observed_at: FAILURE_TIME,
        synced_at: FAILURE_TIME,
        native_transfer_tao: "1.0",
        stake_flow_tao: "0",
        economic_activity_tao: "1.0",
        fee_tao: "0.1",
        tip_tao: "0.01",
        issuance_tao: "0",
        subnet_ids: "[]",
        economics_complete: false,
      },
    ],
    extrinsicRows: [
      {
        block_number: block,
        extrinsic_index: 0,
        extrinsic_hash: `0x${(block + 1).toString(16).padStart(64, "0")}`,
        signer: null,
        call_module: "System",
        call_function: `remark-${block}`,
        success: true,
        fee_tao: "0.1",
        tip_tao: "0.01",
        call_args: JSON.stringify([
          { name: "memo", type: "Bytes", value: `synthetic-${block}` },
        ]),
        observed_at: FAILURE_TIME,
      },
    ],
    chainEventRows: [
      {
        block_number: block,
        event_index: 0,
        pallet: "System",
        method: "ExtrinsicSuccess",
        args: "[]",
        phase: "ApplyExtrinsic",
        extrinsic_index: 0,
        observed_at: FAILURE_TIME,
      },
    ],
    accountEventRows: [
      {
        block_number: block,
        event_index: 1,
        extrinsic_index: 0,
        event_kind: "Transfer",
        hotkey: null,
        coldkey: null,
        netuid: null,
        uid: null,
        amount_tao: "1.0",
        alpha_amount: null,
        observed_at: FAILURE_TIME,
      },
    ],
  };
}
export function partialFailureFamilies(block: number): QueueExpectedFamilies {
  const result = failureFamilies(block);
  result.blockRows = [];
  result.chainEventRows = [];
  return result;
}
function normalize(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([column, initial]) => {
      let value = initial ?? null;
      if (["observed_at", "synced_at"].includes(column) && value !== null) {
        value = Number(value);
        assert.ok(Number.isSafeInteger(value));
      }
      if (column === "subnet_ids" && typeof value === "string")
        value = JSON.parse(value);
      return [column, value];
    }),
  );
}
/** Same exact expected columns and values, including absent coverage and chain-event rows. */
export function assertFailureRows(
  actual: QueueExpectedFamilies,
  expected: QueueExpectedFamilies,
) {
  for (const [, family] of FAILURE_FAMILIES) {
    const sort = (rows: Record<string, unknown>[]) =>
      rows
        .map(normalize)
        .sort(
          (a, b) =>
            Number(a.block_number) - Number(b.block_number) ||
            Number(a.extrinsic_index ?? a.event_index ?? 0) -
              Number(b.extrinsic_index ?? b.event_index ?? 0),
        );
    assert.deepEqual(sort(actual[family]), sort(expected[family]));
  }
  return {
    rowCounts: FAILURE_FAMILIES.map(([, family]) => expected[family].length),
    contentSha256: sha256(JSON.stringify(actual)),
  };
}
export interface FailureCancellationEvidence {
  holder: FailureHolder;
  initial: Record<string, any>[];
  revalidated: Record<string, any>[];
  signalResult: Record<string, any>[];
}
export interface FailurePostgresFixture {
  arm(block: number): Promise<void>;
  waitForSelected(stillPending: () => boolean): Promise<FailureWaiter>;
  cancelSelected(
    witness: FailureWaiter,
    stillPending: () => boolean,
  ): Promise<void>;
  rollback(): Promise<void>;
  verifyRows(
    expected: QueueExpectedFamilies,
  ): Promise<{ rowCounts: number[]; contentSha256: string }>;
  drain(): Promise<{ remainingWriterSessions: 0; stableZeroSamples: 2 }>;
  healthy(): Promise<void>;
  cancellationEvidence(): FailureCancellationEvidence | null;
  close(): Promise<void>;
}
export async function openFailurePostgresFixture(
  blocks: readonly number[],
  sourceRoot: string,
): Promise<FailurePostgresFixture> {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(
    blocks.length >= 1 &&
      blocks.length <= 8 &&
      new Set(blocks).size === blocks.length,
  );
  for (const block of blocks)
    assert.ok(
      Number.isSafeInteger(block) && block >= 9_300_000 && block < 9_500_000,
    );
  queueSchemaStatements(
    readFileSync(join(sourceRoot, "db/schema.sql"), "utf8"),
  );
  const require = createRequire(join(sourceRoot, "package.json"));
  const packageJson = JSON.parse(
    readFileSync(require.resolve("pg/package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "pg");
  assert.equal(packageJson.version, "8.22.0");
  const pg = await import(require.resolve("pg"));
  const Client = pg.Client ?? pg.default?.Client;
  assert.equal(typeof Client, "function");
  const clients: QueryClient[] = [];
  let observer: QueryClient,
    controller: QueryClient | undefined,
    holder: FailureHolder | undefined;
  let transactionStarted = false,
    closed = false,
    cancellationUsed = false;
  let cancellation: FailureCancellationEvidence | null = null;
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
  const rollback = async () => {
    if (!transactionStarted) return;
    assert.ok(controller);
    await withinOwnerDeadline(controller.query("ROLLBACK"), 6000);
    transactionStarted = false;
    // Validate actual holder transaction lock disappeared before any readback.
    if (holder) {
      const locks = await observer.query(
        "SELECT pid FROM pg_locks WHERE pid = $1 AND locktype = 'transactionid' AND transactionid::text = $2 AND granted",
        [holder.pid, holder.transactionId],
      );
      assert.deepEqual(locks.rows, []);
    }
  };
  const close = async () => {
    if (closed) return;
    const failures: unknown[] = [];
    try {
      await rollback();
    } catch (error) {
      failures.push(error);
    }
    const ends = await Promise.allSettled(
      clients.map((client) => withinOwnerDeadline(client.end(), 6000)),
    );
    for (const result of ends)
      if (result.status === "rejected") failures.push(result.reason);
    closed = true;
    if (failures.length)
      throw new AggregateError(
        failures,
        "Failure fixture cleanup did not complete cleanly",
      );
  };
  const verifyRows = async (expected: QueueExpectedFamilies) => {
    assert.equal(
      transactionStarted,
      false,
      "Controller ROLLBACK is mandatory before durable readback",
    );
    const actual = emptyFailureFamilies();
    for (const [table, family, order] of FAILURE_FAMILIES) {
      for (const row of expected[family])
        assert.ok(blocks.includes(Number(row.block_number)));
      const result = await observer.query(
        `SELECT * FROM ${table} WHERE block_number = ANY($1::integer[]) ORDER BY ${order}`,
        [[...blocks]],
      );
      actual[family] = result.rows;
    }
    return assertFailureRows(actual, expected);
  };
  const healthy = async () => {
    const result = await observer.query(
      "SELECT current_database() AS database, current_user AS username, current_setting('server_version_num') AS version, 1 AS ready",
    );
    assert.deepEqual(result.rows, [
      {
        database: POSTGRES_OWNER.database,
        username: POSTGRES_OWNER.admin,
        version: POSTGRES_OWNER.serverVersionNum,
        ready: 1,
      },
    ]);
  };
  try {
    observer = await connect("qualification-failure-observer");
    await healthy();
    const tables = await observer.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    assert.deepEqual(
      tables.rows.map((row) => row.tablename),
      [...QUEUE_TABLES].sort(),
    );
    const role = await observer.query(
      "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = $1",
      [POSTGRES_OWNER.writer],
    );
    assert.deepEqual(role.rows, [
      {
        rolname: POSTGRES_OWNER.writer,
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolconnlimit: 8,
        rolconfig: [
          "statement_timeout=20000ms",
          "lock_timeout=15000ms",
          "idle_in_transaction_session_timeout=20000ms",
        ],
      },
    ]);
    await verifyRows(emptyFailureFamilies());
    return {
      async arm(block) {
        assert.ok(blocks.includes(block));
        assert.equal(controller, undefined);
        assert.equal(transactionStarted, false);
        controller = await connect("qualification-failure-lock");
        await controller.query("BEGIN");
        transactionStarted = true;
        // The deliberate conflict is uncommitted and is never made durable.
        await controller.query(
          "INSERT INTO chain_detail_chain_events (block_number, event_index, pallet, method, args, phase, extrinsic_index, observed_at) VALUES ($1, 0, 'System', 'ControllerUncommitted', '[]', 'ApplyExtrinsic', 0, 1)",
          [block],
        );
        const identity = await controller.query(
          "SELECT pg_backend_pid() AS pid, backend_start::text AS backend_start, pg_current_xact_id()::text AS transaction_id FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        assert.equal(identity.rows.length, 1);
        holder = {
          block,
          pid: identity.rows[0]!.pid,
          backendStart: identity.rows[0]!.backend_start,
          transactionId: identity.rows[0]!.transaction_id,
        };
      },
      async waitForSelected(stillPending) {
        assert.ok(transactionStarted && holder);
        const deadline = performance.now() + POSTGRES_OWNER.barrierTimeoutMs;
        while (performance.now() < deadline) {
          assert.ok(
            stillPending(),
            "Selected owner settled before authenticated lock witness",
          );
          const result = await observer.query(FAILURE_WAIT_SQL, [
            POSTGRES_OWNER.database,
            POSTGRES_OWNER.writer,
            holder.pid,
          ]);
          if (result.rows.length) {
            const witness = validateFailureWaiter(result.rows, holder);
            assert.ok(stillPending());
            cancellation = {
              holder: structuredClone(holder),
              initial: structuredClone(result.rows),
              revalidated: [],
              signalResult: [],
            };
            return witness;
          }
          await delay(25);
        }
        throw new Error(
          "Selected real writer did not reach the owned chain-event lock",
        );
      },
      async cancelSelected(witness, stillPending) {
        assert.ok(transactionStarted && holder);
        assert.equal(cancellationUsed, false);
        assert.ok(stillPending());
        assert.deepEqual(witness.holder, holder);
        const current = await observer.query(FAILURE_WAIT_SQL, [
          POSTGRES_OWNER.database,
          POSTGRES_OWNER.writer,
          holder.pid,
        ]);
        assertSameFailureWaiter(
          validateFailureWaiter(current.rows, holder),
          witness,
        );
        assert.ok(cancellation);
        cancellation.revalidated = structuredClone(current.rows);
        assert.ok(stillPending());
        cancellationUsed = true;
        const result = await observer.query(
          FAILURE_CANCEL_SQL,
          cancelParameters(witness),
        );
        assertCancellationResult(result.rows, witness);
        cancellation.signalResult = structuredClone(result.rows);
      },
      rollback,
      verifyRows,
      healthy,
      close,
      cancellationEvidence() {
        return structuredClone(cancellation);
      },
      async drain() {
        const deadline = performance.now() + POSTGRES_OWNER.drainTimeoutMs;
        let zeroSamples = 0;
        while (performance.now() < deadline) {
          const result = await observer.query(
            "SELECT pid, state FROM pg_stat_activity WHERE datname = $1 AND usename = $2",
            [POSTGRES_OWNER.database, POSTGRES_OWNER.writer],
          );
          zeroSamples = result.rows.length ? 0 : zeroSamples + 1;
          if (zeroSamples === 2)
            return { remainingWriterSessions: 0, stableZeroSamples: 2 };
          await delay(50);
        }
        throw new Error("Real failure-scenario writer sessions did not drain");
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Failure fixture setup and cleanup failed",
      );
    }
    throw error;
  }
}
