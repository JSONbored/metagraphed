import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  test,
} from "vitest";
import { createProducerStore } from "../src/producer-store.ts";
import { PASS_TABLES } from "../src/pass-completeness.ts";
import {
  commitSyncDelivery,
  makeSyncDelivery,
} from "../src/sync-delivery-receipt.ts";
import { mirrorLedgerToNeon } from "../src/ledger-neon-write.ts";

// Same disposable Unix-socket-only PostgreSQL model as the root basket races.
// Native CI must actually execute these races; no remote production DB is used.
const bindir = spawnSync("pg_config", ["--bindir"], {
  encoding: "utf8",
}).stdout?.trim();
const available =
  !!bindir &&
  existsSync(path.join(bindir, "initdb")) &&
  existsSync(path.join(bindir, "pg_ctl")) &&
  process.getuid?.() !== 0;
test("native receipt qualification requires actual PostgreSQL server tools", () => {
  if (process.env.CI)
    assert.equal(
      available,
      true,
      "Install PostgreSQL server tools in the native runner; skipped lock tests are not qualification",
    );
});
describe.skipIf(!available)("concurrent delivery transactions", () => {
  let directory: string;
  let admin: Client;
  const clients = new Set<Client>();
  const stamp = 1790000000000;
  const rows = ["a", "b", "c"].map((ss58) => ({
    ss58,
    free_tao: 1,
    reserved_tao: 0,
    captured_at: stamp,
  }));
  function store(name: string) {
    const connection = new Client({
      host: directory,
      user: "delivery_test",
      database: "postgres",
      application_name: name,
      statement_timeout: 5000,
    });
    clients.add(connection);
    return createProducerStore("unused-local-fixture", {
      clientFactory: () => connection,
    });
  }
  const pass = (r = rows) => ({
    capturedAt: stamp,
    expectedRows: 3,
    receivedRows: r.length,
    nowMs: stamp + 100,
    delivery: makeSyncDelivery("account-balances", stamp, 3, r),
  });
  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), "delivery-race-"));
    execFileSync(
      path.join(bindir!, "initdb"),
      [
        "-D",
        path.join(directory, "data"),
        "-U",
        "delivery_test",
        "-A",
        "trust",
        "--no-locale",
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      path.join(bindir!, "pg_ctl"),
      [
        "-D",
        path.join(directory, "data"),
        "-l",
        path.join(directory, "server.log"),
        "-o",
        `-c listen_addresses='' -c unix_socket_directories='${directory}'`,
        "-w",
        "start",
      ],
      { stdio: "ignore" },
    );
    admin = new Client({
      host: directory,
      user: "delivery_test",
      database: "postgres",
      statement_timeout: 5000,
    });
    await admin.connect();
    for (const table of Object.values(PASS_TABLES))
      await admin.query(
        `CREATE TABLE ${table}(captured_at BIGINT PRIMARY KEY,expected_rows INTEGER NOT NULL,received_rows INTEGER NOT NULL DEFAULT 0,completed_at BIGINT)`,
      );
    await admin.query(
      "CREATE TABLE account_balances(ss58 TEXT PRIMARY KEY,free_tao DOUBLE PRECISION NOT NULL,reserved_tao DOUBLE PRECISION NOT NULL,captured_at BIGINT NOT NULL)",
    );
    await admin.query(
      readFileSync("deploy/sync-delivery-receipts/postgres.sql", "utf8"),
    );
  }, 30000);
  beforeEach(async () => {
    await admin.query(
      "TRUNCATE sync_delivery_receipts,sync_delivery_passes,account_balances,account_balances_passes CASCADE",
    );
  });
  afterEach(async () => {
    await admin.query("SELECT pg_advisory_unlock_all()");
    await Promise.allSettled([...clients].map((client) => client.end()));
    clients.clear();
  });
  afterAll(async () => {
    await admin?.end();
    if (directory) {
      spawnSync(
        path.join(bindir!, "pg_ctl"),
        ["-D", path.join(directory, "data"), "-m", "immediate", "-w", "stop"],
        { stdio: "ignore" },
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
  async function waiting(name: string, event: string) {
    for (let i = 0; i < 300; i++) {
      const result = await admin.query(
        "SELECT wait_event FROM pg_stat_activity WHERE application_name=$1",
        [name],
      );
      if (result.rows[0]?.wait_event === event) return;
      await admin.query("SELECT pg_sleep(0.01)");
    }
    assert.fail(`${name} did not reach ${event} lock`);
  }
  for (const overlap of [false, true])
    test(
      overlap
        ? "overlapping writers cannot both credit their rows"
        : "simultaneous duplicates commit business rows and credit once",
      async () => {
        await admin.query("SELECT pg_advisory_lock(941517)");
        const firstRows = overlap ? rows.slice(0, 2) : rows;
        const first = commitSyncDelivery(
          store("first"),
          "account-balances",
          firstRows,
          pass(firstRows),
          [
            { text: "SELECT pg_advisory_xact_lock(941517)" },
            ...firstRows.map((r) => ({
              text: "INSERT INTO account_balances VALUES(?,?,?,?)",
              values: [r.ss58, r.free_tao, r.reserved_tao, r.captured_at],
            })),
          ],
        );
        const firstResult = first.then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        );
        await waiting("first", "advisory");
        const secondRows = overlap ? rows.slice(1) : rows;
        const second = commitSyncDelivery(
          store("second"),
          "account-balances",
          secondRows,
          pass(secondRows),
          [
            ...secondRows.map((r) => ({
              text: "INSERT INTO account_balances VALUES(?,?,?,?)",
              values: [r.ss58, r.free_tao, r.reserved_tao, r.captured_at],
            })),
          ],
        );
        const secondResult = second.then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        );
        await waiting("second", "transactionid");
        assert.equal(
          (
            await admin.query(
              "SELECT COUNT(*)::int n FROM sync_delivery_receipts",
            )
          ).rows[0].n,
          0,
        );
        await admin.query("SELECT pg_advisory_unlock(941517)");
        assert.equal((await firstResult).ok, true);
        assert.equal((await secondResult).ok, !overlap);
        const result = (
          await admin.query("SELECT received_rows FROM account_balances_passes")
        ).rows[0];
        assert.equal(result.received_rows, overlap ? 2 : 3);
        assert.equal(
          (await admin.query("SELECT COUNT(*)::int n FROM account_balances"))
            .rows[0].n,
          overlap ? 2 : 3,
        );
      },
    );
  test("actual PostgreSQL mirror uses one atomic unit and handles replay", async () => {
    const env = {
      HYPERDRIVE: {
        connectionString: `postgresql://delivery_test@localhost/postgres?host=${encodeURIComponent(directory)}`,
      },
    };
    const health = { query: async () => [], run: async () => ({ changes: 1 }) };
    const result = await mirrorLedgerToNeon(
      env,
      null,
      "account-balances",
      rows,
      { laneHealthDb: health },
      pass(),
    );
    assert.equal(result.result?.ok, true, result.result?.reason);
    assert.equal(
      (
        await mirrorLedgerToNeon(
          env,
          null,
          "account-balances",
          rows,
          { laneHealthDb: health },
          pass(),
        )
      ).result?.ok,
      true,
    );
    assert.equal(
      (await admin.query("SELECT received_rows FROM account_balances_passes"))
        .rows[0].received_rows,
      3,
    );
  });
});
