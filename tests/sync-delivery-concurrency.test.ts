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
import { PASS_TABLES, type PassTallyInput } from "../src/pass-completeness.ts";
import {
  commitSyncDelivery,
  makeSyncDelivery,
} from "../src/sync-delivery-receipt.ts";
import { mirrorLedgerToNeon } from "../src/ledger-neon-write.ts";
import {
  mirrorNominatorPositionsToNeon,
  coldkeyMaxCapturedAt,
} from "../src/nominator-positions-neon-write.ts";
import {
  mirrorNeuronSnapshotToNeon,
  neuronSnapshotWrite,
} from "../src/neurons-neon-write.ts";
import { writeIdentifiedPostgres } from "../src/sync-delivery-postgres.ts";
import {
  writeSyncBatch,
  validSyncBatchMessage,
  type SyncBatchMessage,
} from "../src/sync-batch-queue.ts";
import {
  deliveryKeyFixtures,
  uncheckedDelivery,
} from "./helpers/sync-delivery-key-fixtures.ts";

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
    for (const file of [
      "0007_hand_created_tables.sql",
      "0008_hotkey_alpha.sql",
      "0025_nominator_positions_shares.sql",
      "0027_nominator_positions_source.sql",
      "0035_nominator_scan_receipts.sql",
    ])
      await admin.query(readFileSync(`migrations/neon/${file}`, "utf8"));
    await admin.query(
      readFileSync("deploy/sync-delivery-receipts/postgres.sql", "utf8"),
    );
  }, 30000);
  beforeEach(async () => {
    await admin.query(
      `TRUNCATE sync_delivery_receipts,sync_delivery_passes,account_balances,hotkey_alpha,nominator_positions,nominator_scan_receipts,validator_nominator_counts,neurons,neuron_daily,account_position_daily,${Object.values(PASS_TABLES).join(",")} CASCADE`,
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
  const environment = () => ({
    HYPERDRIVE: {
      connectionString: `postgresql://delivery_test@localhost/postgres?host=${encodeURIComponent(directory)}`,
    },
  });
  const ordinaryHealth = {
    query: async () => [],
    run: async () => ({ changes: 1 }),
  };
  const positionRows = [
    {
      coldkey: "c",
      hotkey: "h",
      netuid: 1,
      shares: "340282366920938463463374607431768211455",
      share_fraction: 1,
      captured_at: stamp,
    },
  ];
  const positionInput = () => ({
    rows: positionRows,
    coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(positionRows),
    pass: {
      capturedAt: stamp,
      expectedRows: 1,
      receivedRows: 1,
      nowMs: stamp + 100,
      delivery: makeSyncDelivery("nominator-positions", stamp, 1, positionRows),
    },
  });
  const neuronRows = [
    {
      netuid: 1,
      uid: 0,
      hotkey: "h",
      coldkey: "c",
      active: true,
      captured_at: stamp,
    },
  ];
  const neuronInput = () => ({
    ...neuronSnapshotWrite(neuronRows, stamp + 100),
    pass: {
      capturedAt: stamp,
      expectedRows: 1,
      receivedRows: 1,
      nowMs: stamp + 100,
      delivery: makeSyncDelivery("neurons", stamp, 1, neuronRows),
    },
  });
  test("identified positions and neurons persist all families and report health only after commit", async () => {
    const verdicts: string[] = [];
    let expectedLane = "nominator-positions";
    let expectedDelivery = positionInput().pass.delivery;
    const health = {
      query: async () => [],
      run: async (_text: string, values?: unknown[]) => {
        assert.ok(
          (
            await admin.query(
              "SELECT COUNT(*)::int n FROM sync_delivery_receipts WHERE lane=$1 AND captured_at=$2 AND id=$3 AND sha256=$4",
              [
                expectedLane,
                stamp,
                expectedDelivery.id,
                expectedDelivery.sha256,
              ],
            )
          ).rows[0].n > 0,
        );
        verdicts.push(String(values?.[0]));
        return { changes: 1 };
      },
    };
    const positions = await mirrorNominatorPositionsToNeon(
      environment(),
      null,
      positionInput(),
      { laneHealthDb: health },
    );
    assert.equal(positions.write?.ok, true, positions.write?.reason);
    assert.equal(positions.pass?.ok, true);
    assert.equal(
      (
        await mirrorNominatorPositionsToNeon(
          environment(),
          null,
          positionInput(),
          { laneHealthDb: health },
        )
      ).pass?.ok,
      true,
    );
    assert.equal(
      (await admin.query("SELECT shares::text FROM nominator_positions"))
        .rows[0].shares,
      positionRows[0]!.shares,
    );
    assert.equal(
      (await admin.query("SELECT COUNT(*)::int n FROM nominator_scan_receipts"))
        .rows[0].n,
      1,
    );
    expectedLane = "neurons";
    expectedDelivery = neuronInput().pass.delivery;
    const neurons = await mirrorNeuronSnapshotToNeon(
      environment(),
      null,
      neuronInput(),
      { laneHealthDb: health },
    );
    assert.ok(Object.values(neurons.results).every((result) => result.ok));
    assert.equal(neurons.prune?.ok, true);
    const withoutPrune = { ...neuronInput(), netuidMaxCapturedAt: undefined };
    assert.ok(
      Object.values(
        (
          await mirrorNeuronSnapshotToNeon(environment(), null, withoutPrune, {
            laneHealthDb: health,
          })
        ).results,
      ).every((result) => result.ok),
    );
    for (const table of ["neurons", "neuron_daily", "account_position_daily"])
      assert.equal(
        (await admin.query(`SELECT COUNT(*)::int n FROM ${table}`)).rows[0].n,
        1,
      );
    assert.ok(verdicts.some((lane) => lane.includes("normalize")));
    assert.ok(verdicts.some((lane) => lane.includes("coverage")));
  });
  test("required native PostgreSQL prune failures roll back every new family and receipt", async () => {
    await admin.query(
      "INSERT INTO nominator_positions(coldkey,hotkey,netuid,shares,share_fraction,captured_at,source) VALUES('c','old',1,1,1,$1,'alpha')",
      [stamp - 1],
    );
    await admin.query(
      "INSERT INTO neurons(netuid,uid,hotkey,captured_at) VALUES(1,9,'old',$1)",
      [stamp - 1],
    );
    await admin.query(
      "CREATE FUNCTION fixture_reject_prune() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected required prune failure'; END; $$",
    );
    for (const table of ["nominator_positions", "neurons"])
      await admin.query(
        `CREATE TRIGGER fixture_reject_prune BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION fixture_reject_prune()`,
      );
    try {
      const positionResult = await mirrorNominatorPositionsToNeon(
        environment(),
        null,
        positionInput(),
        { laneHealthDb: ordinaryHealth },
      );
      assert.equal(positionResult.write?.ok, false);
      const neuronResult = await mirrorNeuronSnapshotToNeon(
        environment(),
        null,
        neuronInput(),
        { laneHealthDb: ordinaryHealth },
      );
      assert.equal(neuronResult.results.neurons!.ok, false);
      assert.equal(neuronResult.writePath, "postgres-direct");
    } finally {
      for (const table of ["nominator_positions", "neurons"])
        await admin.query(`DROP TRIGGER fixture_reject_prune ON ${table}`);
      await admin.query("DROP FUNCTION fixture_reject_prune()");
    }
    for (const table of [
      "sync_delivery_receipts",
      "nominator_scan_receipts",
      "neuron_daily",
      "account_position_daily",
    ])
      assert.equal(
        (await admin.query(`SELECT COUNT(*)::int n FROM ${table}`)).rows[0].n,
        0,
      );
    assert.deepEqual(
      (await admin.query("SELECT hotkey FROM nominator_positions")).rows,
      [{ hotkey: "old" }],
    );
    assert.deepEqual((await admin.query("SELECT uid FROM neurons")).rows, [
      { uid: 9 },
    ]);
    const changedRows = rows.map((row) => ({ ...row, free_tao: 2 }));
    const ledger = await mirrorLedgerToNeon(
      environment(),
      null,
      "account-balances",
      changedRows,
      { laneHealthDb: ordinaryHealth },
      pass(),
    );
    assert.equal(ledger.result?.ok, false);
  });
  test("unbound identified writers and failed statement preparation never acknowledge delivery", async () => {
    assert.equal(
      (
        await mirrorLedgerToNeon(
          null,
          null,
          "account-balances",
          rows,
          {},
          pass(),
        )
      ).result?.ok,
      false,
    );
    assert.equal(
      (await mirrorNominatorPositionsToNeon(null, null, positionInput())).write
        ?.ok,
      false,
    );
    const neuronResult = await mirrorNeuronSnapshotToNeon(
      null,
      null,
      neuronInput(),
    );
    assert.equal(neuronResult.results.neurons!.ok, false);
    assert.equal(neuronResult.writePath, "unbound");
    await assert.rejects(
      writeIdentifiedPostgres(
        "unused-local-fixture",
        "account-balances",
        rows,
        pass(),
        async () => ({ result: { ok: false } }),
      ),
      /preparation failed/,
    );
  });
  test("native PostgreSQL cannot gain completeness credit from canonical business key aliases", async () => {
    for (const fixture of deliveryKeyFixtures) {
      await admin.query(
        `TRUNCATE sync_delivery_receipts,sync_delivery_passes,account_balances,hotkey_alpha,nominator_positions,nominator_scan_receipts,validator_nominator_counts,neurons,neuron_daily,account_position_daily,${Object.values(PASS_TABLES).join(",")} CASCADE`,
      );
      if (fixture.lane === "hotkey-alpha")
        await admin.query(
          "INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at) VALUES('seed','1',1,1,$1)",
          [stamp],
        );
      const nativeWrite = async (
        incoming: Record<string, unknown>[],
        tally: PassTallyInput | null,
      ) => {
        assert.ok(tally);
        if (fixture.lane === "neurons") {
          const result = await mirrorNeuronSnapshotToNeon(
            environment(),
            null,
            { ...neuronSnapshotWrite(incoming, stamp + 100), pass: tally },
            { laneHealthDb: ordinaryHealth },
          );
          assert.ok(Object.values(result.results).every((r) => r.ok));
        } else if (fixture.lane === "nominator-positions") {
          const result = await mirrorNominatorPositionsToNeon(
            environment(),
            null,
            {
              rows: incoming,
              coldkeyMaxCapturedAt: coldkeyMaxCapturedAt(incoming),
              pass: tally,
            },
            { laneHealthDb: ordinaryHealth },
          );
          assert.equal(result.write?.ok, true, result.write?.reason);
        } else {
          const result = await mirrorLedgerToNeon(
            environment(),
            null,
            fixture.lane,
            incoming,
            { laneHealthDb: ordinaryHealth },
            tally,
          );
          assert.equal(result.result?.ok, true, result.result?.reason);
        }
      };
      const original = { ...fixture.valid, captured_at: stamp };
      const message = (row: Record<string, unknown>): SyncBatchMessage => ({
        lane: fixture.lane,
        captured_at: stamp,
        pass_total: 2,
        key_complete: true,
        rows: [row],
        delivery: uncheckedDelivery(fixture, [row], stamp),
      });
      let writes = 0;
      const writer = async (
        incoming: Record<string, unknown>[],
        tally: PassTallyInput | null,
      ) => {
        writes++;
        await nativeWrite(incoming, tally);
      };
      await writeSyncBatch(
        message(original),
        { [fixture.lane]: writer },
        stamp + 100,
      );
      for (const override of fixture.invalid) {
        const alias = { ...original, ...override };
        const packet = message(alias);
        assert.equal(validSyncBatchMessage(packet), false);
        await assert.rejects(
          writeSyncBatch(packet, { [fixture.lane]: writer }, stamp + 100),
          /canonical business key/,
        );
        await assert.rejects(
          nativeWrite([alias], {
            capturedAt: stamp,
            expectedRows: 2,
            receivedRows: 1,
            nowMs: stamp + 100,
            delivery: packet.delivery,
          }),
        );
      }
      assert.equal(writes, 1);
      const table = fixture.lane.replaceAll("-", "_");
      assert.equal(
        (await admin.query(`SELECT COUNT(*)::int n FROM ${table}`)).rows[0].n,
        1,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT COUNT(*)::int n FROM sync_delivery_receipts",
          )
        ).rows[0].n,
        1,
      );
      const tally = (
        await admin.query(
          `SELECT received_rows,completed_at FROM ${PASS_TABLES[fixture.lane]}`,
        )
      ).rows[0];
      assert.equal(tally.received_rows, 1);
      assert.equal(tally.completed_at, null);
    }
  });
});
