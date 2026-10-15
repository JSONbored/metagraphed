import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
import { createD1Store } from "../src/d1-store.ts";
import {
  createProducerStore,
  type ProducerStore,
} from "../src/producer-store.ts";
import { PASS_TABLES, latestCompletePass } from "../src/pass-completeness.ts";
import {
  commitSyncDelivery,
  makeSyncDelivery,
  syncDeliveryBytes,
  syncDeliveryEvidence,
  syncDeliveryKey,
  validSyncDelivery,
  verifySyncDelivery,
} from "../src/sync-delivery-receipt.ts";
import {
  enqueueSyncBatch,
  packSyncBatchMessages,
  passTallyFor,
  syncBatchRows,
} from "../src/sync-batch-queue.ts";
import { writeLedgerD1, writeNominatorPositionsD1 } from "../src/ledger-d1.ts";

const stamp = 1790000000000;
const rows = ["a", "b", "c", "d"].map((ss58) => ({
  ss58,
  free_tao: 1,
  reserved_tao: 0,
  captured_at: stamp,
}));
const pass = (r = rows, total = 4, at = stamp) => ({
  capturedAt: at,
  expectedRows: total,
  receivedRows: r.length,
  nowMs: at + 100,
  delivery: makeSyncDelivery("account-balances", at, total, r),
});
const sql = (name: string) =>
  readFileSync(`deploy/sync-delivery-receipts/${name}.sql`, "utf8");

test("canonical encoding matches Rust golden vectors and exact quantity strings", () => {
  const vectors = JSON.parse(
    readFileSync("tests/fixtures/sync-delivery-v1.json", "utf8"),
  );
  for (const vector of vectors)
    assert.equal(syncDeliveryBytes(vector.value).toString("hex"), vector.hex);
  assert.deepEqual(
    syncDeliveryBytes({ a: null, b: 1 }),
    syncDeliveryBytes({ b: 1 }),
  );
  assert.throws(() => syncDeliveryBytes(Infinity));
  assert.throws(() => syncDeliveryBytes(1n));
  assert.throws(() => syncDeliveryBytes({ "not-column": 1 }));
  assert.throws(() => syncDeliveryKey("unknown", {}));
  assert.throws(() => syncDeliveryKey("account-balances", {}));
  assert.deepEqual(syncDeliveryBytes(undefined), syncDeliveryBytes(null));
});

test("identity freezes census and keys while digest freezes business content", () => {
  const a = pass(rows.slice(0, 2));
  const changed = rows.slice(0, 2).map((r) => ({ ...r, free_tao: 2 }));
  const b = pass(changed);
  assert.equal(a.delivery.id, b.delivery.id);
  assert.notEqual(a.delivery.sha256, b.delivery.sha256);
  assert.notEqual(a.delivery.id, pass(rows.slice(0, 2), 5).delivery.id);
  assert.equal(syncDeliveryEvidence(a), "identified-v1");
  assert.equal(syncDeliveryEvidence(), "legacy-ambiguous");
  assert.equal(
    syncDeliveryEvidence({ ...a, delivery: undefined }),
    "legacy-ambiguous",
  );
  assert.equal(validSyncDelivery(a.delivery), true);
  for (const bad of [
    null,
    1,
    {},
    { ...a.delivery, version: 2 },
    { ...a.delivery, id: "x" },
    { ...a.delivery, extra: 1 },
    { ...a.delivery, parent_id: a.delivery.id },
  ])
    assert.equal(validSyncDelivery(bad), false);
  for (const bad of [
    [],
    [rows[1]!, rows[0]!],
    [rows[0]!, rows[0]!],
    [{ ...rows[0]!, captured_at: stamp + 1 }],
  ])
    assert.throws(() => makeSyncDelivery("account-balances", stamp, 4, bad));
  assert.throws(() => makeSyncDelivery("account-balances", 1, 4, rows));
  assert.throws(() => makeSyncDelivery("account-balances", stamp, 3, rows));
  assert.throws(() => makeSyncDelivery("account-balances", stamp, NaN, rows));
  assert.throws(() =>
    verifySyncDelivery(null, "account-balances", a, rows.slice(0, 2)),
  );
  assert.throws(() =>
    verifySyncDelivery(
      a.delivery,
      "account-balances",
      { ...a, receivedRows: 1 },
      rows.slice(0, 2),
    ),
  );
  assert.throws(() =>
    verifySyncDelivery(a.delivery, "account-balances", a, changed),
  );
});

for (const dialect of ["sqlite", "postgres"] as const)
  describe(`business receipts on ${dialect}`, () => {
    let store: ProducerStore;
    let db: D1Database;
    let pg: PGlite;
    let runtime: Miniflare;
    const fixtureTable = `CREATE TABLE business_rows(ss58 TEXT PRIMARY KEY,free_tao REAL NOT NULL,reserved_tao REAL NOT NULL,captured_at ${dialect === "sqlite" ? "INTEGER" : "BIGINT"} NOT NULL)`;
    const execute = async (text: string) => {
      if (dialect === "sqlite") await db.exec(text);
      else await pg.exec(text);
    };
    beforeAll(async () => {
      if (dialect === "sqlite") {
        runtime = new Miniflare({
          modules: true,
          script: "export default {fetch(){return new Response('fixture')}}",
          compatibilityDate: "2026-06-06",
          d1Databases: ["DB"],
        });
        db = await runtime.getD1Database("DB");
        store = createD1Store(db);
        for (const statement of readFileSync(
          "migrations/d1/0010_ledger_state.sql",
          "utf8",
        ).split("-- statement-breakpoint"))
          if (statement.trim()) await db.prepare(statement).run();
        const neurons = readFileSync(
          "migrations/d1/0007_neuron_documents.sql",
          "utf8",
        )
          .split("-- statement-breakpoint")
          .find((s) => s.includes("CREATE TABLE neurons_passes"))!;
        await db.prepare(neurons).run();
      } else {
        pg = new PGlite();
        for (const table of Object.values(PASS_TABLES))
          await pg.exec(
            `CREATE TABLE ${table}(captured_at BIGINT PRIMARY KEY,expected_rows INTEGER NOT NULL,received_rows INTEGER NOT NULL DEFAULT 0,completed_at BIGINT)`,
          );
        store = createProducerStore("postgresql://fixture/db", {
          clientFactory: () => ({
            connect: async () => {},
            end: async () => {},
            query: async (text, values) => {
              const result = await pg.query(text, values);
              return { rows: result.rows, rowCount: result.affectedRows };
            },
          }),
        });
      }
      await execute(fixtureTable);
      // Qualification schemas are explicit native inputs, never fake entries in
      // the production migration ledger or ownership configuration.
      if (dialect === "sqlite") {
        // D1 exec splits physical newlines; use prepared statements for triggers.
        for (const statement of sql(dialect)
          .split(/(?<=;)\n(?=CREATE|--|\n)/)
          .filter((s) => s.trim()))
          await db.prepare(statement).run();
      } else await pg.exec(sql(dialect));
    });
    afterAll(async () => {
      await store.close();
      if (dialect === "sqlite") await runtime.dispose();
      else await pg.close();
    });
    beforeEach(async () => {
      for (const table of [
        "sync_delivery_receipts",
        "sync_delivery_passes",
        "business_rows",
        ...Object.values(PASS_TABLES),
      ])
        await execute(`DELETE FROM ${table}`);
      if (dialect === "sqlite")
        for (const table of [
          "account_balances",
          "hotkey_alpha",
          "nominator_positions",
          "nominator_scan_receipts",
        ])
          await execute(`DELETE FROM ${table}`);
    });
    const count = async (table: string) =>
      Number(
        (await store.first<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`))!
          .n,
      );
    const write = (
      r = rows,
      total = 4,
      at = stamp,
      target = store,
      extra: { text: string; values?: unknown[] }[] = [],
    ) =>
      commitSyncDelivery(target, "account-balances", r, pass(r, total, at), [
        ...r.map((row) => ({
          text: "INSERT INTO business_rows(ss58,free_tao,reserved_tao,captured_at) VALUES(?,?,?,?) ON CONFLICT(ss58) DO UPDATE SET free_tao=excluded.free_tao,captured_at=excluded.captured_at WHERE business_rows.captured_at<excluded.captured_at",
          values: [row.ss58, row.free_tao, row.reserved_tao, row.captured_at],
        })),
        ...extra,
      ]);
    const tally = () =>
      store.first<{
        expected_rows: number;
        received_rows: number;
        completed_at: number | null;
      }>(
        "SELECT expected_rows,received_rows,completed_at FROM account_balances_passes WHERE captured_at=?",
        [stamp],
      );

    test("republication cannot complete a pass with missing rows", async () => {
      await write(rows.slice(0, 2));
      await write(rows.slice(0, 2));
      assert.equal(await count("business_rows"), 2);
      assert.equal(Number((await tally())!.received_rows), 2);
      assert.equal((await tally())!.completed_at, null);
      await write(rows.slice(2));
      assert.equal(Number((await tally())!.received_rows), 4);
      assert.equal(Number((await tally())!.completed_at), stamp + 100);
      await write(rows.slice(2));
      assert.equal(await count("sync_delivery_receipts"), 2);
    });
    test("lost commit acknowledgement recovers only an exact durable receipt", async () => {
      const lost = {
        ...store,
        transaction: async (
          statements: Parameters<ProducerStore["transaction"]>[0],
        ) => {
          await store.transaction(statements);
          throw new Error("lost ACK");
        },
      };
      await write(rows, 4, stamp, lost);
      await write();
      assert.equal(await count("sync_delivery_receipts"), 1);
      assert.equal(Number((await tally())!.received_rows), 4);
      await assert.rejects(
        write(rows.map((r) => ({ ...r, free_tao: 2 }))),
        /./,
      );
      await assert.rejects(write(rows, 5), /./);
      assert.equal(Number((await tally())!.expected_rows), 4);
    });
    test("overlap, changed repacking and census overflow roll back before accounting", async () => {
      await write(rows.slice(0, 2));
      await assert.rejects(write(rows.slice(1, 3)), /./);
      await assert.rejects(write(rows.slice(0, 1)), /./);
      assert.equal(await count("business_rows"), 2);
      assert.equal(await count("sync_delivery_receipts"), 1);
      await assert.rejects(
        write([...rows.slice(2), { ...rows[3]!, ss58: "e" }]),
        /./,
      );
      assert.equal(Number((await tally())!.received_rows), 2);
    });
    test("required business failure rolls back receipt and all earlier writes", async () => {
      await assert.rejects(
        write(rows, 4, stamp, store, [
          { text: "INSERT INTO missing_business_table VALUES(1)" },
        ]),
        /./,
      );
      assert.equal(await count("business_rows"), 0);
      assert.equal(await count("sync_delivery_receipts"), 0);
      assert.equal(await count("sync_delivery_passes"), 0);
      await write();
      assert.equal(await count("business_rows"), 4);
    });
    test("legacy credit is ambiguous and cannot be adopted or added to identified credit", async () => {
      await store.run(
        "INSERT INTO account_balances_passes(captured_at,expected_rows,received_rows,completed_at) VALUES(?,?,?,?)",
        [stamp, 4, 2, null],
      );
      await assert.rejects(write(rows.slice(0, 2)), /./);
      assert.equal(await count("sync_delivery_receipts"), 0);
      await execute("DELETE FROM account_balances_passes");
      await write(rows.slice(0, 2));
      await assert.rejects(
        store.run(
          "UPDATE account_balances_passes SET received_rows=received_rows+2 WHERE captured_at=?",
          [stamp],
        ),
        /./,
      );
      assert.equal(Number((await tally())!.received_rows), 2);
    });
    test("receipt identity remains protective after arbitrary wall-clock expiry", async () => {
      await write();
      const old = { ...pass(), nowMs: stamp + 365 * 86400000 };
      await commitSyncDelivery(store, "account-balances", rows, old, []);
      assert.equal(await count("sync_delivery_receipts"), 1);
      assert.equal(Number((await tally())!.received_rows), 4);
    });
    test("parent digest is immutable across nonoverlapping queue children", async () => {
      const parent = makeSyncDelivery("account-balances", stamp, 4, rows);
      const first = rows.slice(0, 2),
        second = rows.slice(2);
      await commitSyncDelivery(
        store,
        "account-balances",
        first,
        {
          ...pass(first),
          delivery: makeSyncDelivery(
            "account-balances",
            stamp,
            4,
            first,
            parent,
          ),
        },
        [],
      );
      await assert.rejects(
        commitSyncDelivery(
          store,
          "account-balances",
          second,
          {
            ...pass(second),
            delivery: makeSyncDelivery("account-balances", stamp, 4, second, {
              ...parent,
              sha256: "a".repeat(64),
            }),
          },
          [],
        ),
        /./,
      );
      assert.equal(Number((await tally())!.received_rows), 2);
    });
    test("old delivery completion preserves the existing latest-only serving limitation", async () => {
      const newer = rows.map((r) => ({
        ...r,
        captured_at: stamp + 1000,
        free_tao: 9,
      }));
      await write(newer, 4, stamp + 1000);
      await commitSyncDelivery(
        store,
        "account-balances",
        rows,
        { ...pass(), nowMs: stamp + 5000 },
        [],
      );
      assert.equal(
        Number(
          (await store.first<{ free_tao: number }>(
            "SELECT free_tao FROM business_rows WHERE ss58='a'",
          ))!.free_tao,
        ),
        9,
      );
      const result = await latestCompletePass(
        { first: store.first },
        "account-balances",
      );
      assert.equal(result.capturedAt, stamp);
      assert.equal(await count("sync_delivery_receipts"), 2);
    });
    test("legacy transaction shape still works without manufacturing a receipt", async () => {
      await commitSyncDelivery(store, "account-balances", rows, null, [
        {
          text: "INSERT INTO business_rows VALUES(?,?,?,?)",
          values: ["legacy", 1, 0, stamp],
        },
      ]);
      assert.equal(await count("business_rows"), 1);
      assert.equal(await count("sync_delivery_receipts"), 0);
    });
    test.skipIf(dialect !== "sqlite")(
      "actual ledger and nominator writers commit business receipts once",
      async () => {
        assert.equal(
          (await writeLedgerD1(store, "account-balances", rows, pass())).ok,
          true,
        );
        assert.equal(
          (await writeLedgerD1(store, "account-balances", rows, pass())).ok,
          true,
        );
        assert.equal(await count("account_balances"), 4);
        assert.equal(Number((await tally())!.received_rows), 4);
        const positions = [
          {
            coldkey: "c",
            hotkey: "h",
            netuid: 1,
            shares: "340282366920938463463374607431768211455",
            share_fraction: 1,
            captured_at: stamp,
          },
        ];
        const input = {
          rows: positions,
          coldkeyMaxCapturedAt: new Map([["c", stamp]]),
          pass: {
            capturedAt: stamp,
            expectedRows: 1,
            receivedRows: 1,
            nowMs: stamp + 100,
            delivery: makeSyncDelivery(
              "nominator-positions",
              stamp,
              1,
              positions,
            ),
          },
        };
        assert.equal(
          (await writeNominatorPositionsD1(store, input)).write?.ok,
          true,
        );
        assert.equal(
          (await writeNominatorPositionsD1(store, input)).write?.ok,
          true,
        );
        assert.equal(await count("nominator_scan_receipts"), 1);
        assert.equal(
          (await store.first<{ shares: string }>(
            "SELECT shares FROM nominator_positions",
          ))!.shares,
          positions[0]!.shares,
        );
      },
    );
    test("partial queue send and stable producer republication credit each child once", async () => {
      const parent = makeSyncDelivery("account-balances", stamp, 4, rows);
      const children = packSyncBatchMessages({
        lane: "account-balances",
        capturedAt: stamp,
        passTotal: 4,
        rows,
        delivery: parent,
        maxRows: 2,
      });
      for (const body of [children[0]!, children[0]!, children[1]!]) {
        const decoded = syncBatchRows(body);
        await commitSyncDelivery(
          store,
          body.lane,
          decoded,
          passTallyFor(body, stamp + 100),
          [],
        );
      }
      assert.equal(Number((await tally())!.received_rows), 4);
      assert.equal(await count("sync_delivery_receipts"), 2);
      const changed = packSyncBatchMessages({
        lane: "account-balances",
        capturedAt: stamp,
        passTotal: 4,
        rows,
        delivery: parent,
        maxRows: 1,
      });
      await assert.rejects(
        commitSyncDelivery(
          store,
          "account-balances",
          syncBatchRows(changed[0]!),
          passTallyFor(changed[0]!, stamp + 100),
          [],
        ),
        /./,
      );
      let sends = 0;
      await assert.rejects(
        enqueueSyncBatch(
          {
            send: async () => {
              sends++;
              throw new Error("transport failure");
            },
          },
          {
            lane: "account-balances",
            capturedAt: stamp,
            passTotal: 4,
            rows,
            delivery: parent,
          },
        ),
        /transport/,
      );
      assert.ok(sends > 0);
    });
  });
test("republication cannot change the parent identity of a committed child", async () => {
  const parent = makeSyncDelivery("account-balances", stamp, 4, rows);
  const child = rows.slice(0, 2);
  const delivery = makeSyncDelivery(
    "account-balances",
    stamp,
    4,
    child,
    parent,
  );
  await commitSyncDelivery(
    store,
    "account-balances",
    child,
    { ...pass(child), delivery },
    [],
  );
  for (const changed of [
    { ...delivery, parent_id: "b".repeat(64) },
    { ...delivery, parent_sha256: "b".repeat(64) },
  ])
    await assert.rejects(
      commitSyncDelivery(
        store,
        "account-balances",
        child,
        { ...pass(child), delivery: changed },
        [],
      ),
      /./,
    );
});
test("a corrupt retained receipt cannot certify a retry after restore", async () => {
  await write();
  for (const [column, value] of [
    ["first_key", "00"],
    ["last_key", "ff"],
    ["row_count", 3],
  ] as const) {
    const original = await store.first<Record<string, unknown>>(
      `SELECT ${column} FROM sync_delivery_receipts`,
    );
    await store.run(`UPDATE sync_delivery_receipts SET ${column}=?`, [value]);
    await assert.rejects(write(), /./);
    await store.run(`UPDATE sync_delivery_receipts SET ${column}=?`, [
      original![column],
    ]);
  }
  await store.run("UPDATE sync_delivery_passes SET expected_rows=5");
  await assert.rejects(write(), /./);
});
test("oversized atomic units fail without leaving a pass or receipt", async () => {
  await assert.rejects(
    write(
      rows,
      4,
      stamp,
      store,
      Array.from({ length: 901 }, () => ({ text: "SELECT 1" })),
    ),
    /budget/,
  );
  assert.equal(await count("sync_delivery_receipts"), 0);
});
