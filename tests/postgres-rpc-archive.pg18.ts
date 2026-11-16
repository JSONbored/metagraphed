import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const schema = "rpc_archive_fixture";
const connectionString = pg18FixtureUrl().toString();
const control = new Client({
  connectionString,
  statement_timeout: 5000,
  connectionTimeoutMillis: 2000,
});
const day = "2026-10-01";
const start = Date.parse(`${day}T00:00:00Z`);
const cutoff = start + 86400000;
const table = "11111111-2222-3333-4444-555555555555";
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  ).replaceAll("app.", `${schema}.`);

async function insert(count: number, pool = "public", base = start, salt = "") {
  await control.query(
    `INSERT INTO ${schema}.rpc_usage_events
     SELECT md5($4 || $2 || value::text)::uuid,$3::bigint+value,$2,'"finney"','"node"','"provider"',
         'miss',true,1::float8,12.5::float8,200::float8,1
     FROM generate_series(1,$1::integer) value`,
    [count, pool, base, salt],
  );
}
async function fingerprint(selected = day) {
  return (
    await control.query(
      `SELECT * FROM ${schema}.rpc_usage_day_fingerprint($1::date)`,
      [selected],
    )
  ).rows[0] as { source_rows: string; source_sha256: string };
}
async function receipt(selected = day, client = control, target = table) {
  const source = await fingerprint(selected);
  await client.query(
    `SELECT ${schema}.rpc_usage_record_archive($1::date,$2::bigint,$3,$4,$5,$6::bigint)`,
    [selected, source.source_rows, source.source_sha256, target, "123", cutoff],
  );
  return source;
}
async function prune(limit = 10000, at = cutoff, client = control) {
  return (
    await client.query(
      `SELECT ${schema}.rpc_usage_prune($1::bigint,$2::integer) AS removed`,
      [at, limit],
    )
  ).rows[0].removed as number;
}
async function count(pool = "public") {
  return Number(
    (
      await control.query(
        `SELECT count(*) AS n FROM ${schema}.rpc_usage_events WHERE pool=$1`,
        [pool],
      )
    ).rows[0].n,
  );
}
async function archiveRow() {
  return (await control.query(`SELECT * FROM ${schema}.rpc_usage_archive_days`))
    .rows[0];
}
async function waitForLock(name: string) {
  for (let i = 0; i < 100; i++) {
    const rows = (
      await control.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
        [name],
      )
    ).rows;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected concurrent operation to reach its lock");
}

describe(
  "native RPC archive receipts and bounded retention",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query(`CREATE SCHEMA ${schema}`);
      for (const name of [
        "0038_rpc_usage.sql",
        "0042_rpc_usage_archive.sql",
        "0043_rpc_usage_archive_prune.sql",
      ])
        await control.query(migration(name));
    });
    beforeEach(async () => {
      await control.query(
        `TRUNCATE ${schema}.rpc_usage_events,${schema}.rpc_usage_archive_days`,
      );
      await control.query(
        `UPDATE ${schema}.rpc_usage_prune_state SET after_day=NULL`,
      );
    });
    after(async () => {
      try {
        await control.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await control.end();
      }
    });

    it("retains unarchived public rows and preserves the separate fullnode age policy", async () => {
      await insert(2);
      await insert(2, "fullnode");
      await insert(1, "fullnode", cutoff, "fresh");
      assert.equal(await prune(), 2);
      assert.equal(await count(), 2);
      assert.equal(await count("fullnode"), 1);
    });

    it("deletes at most10000 and advances the remaining fingerprint atomically", async () => {
      await insert(10005);
      const original = await receipt();
      assert.equal(await prune(), 10000);
      const first = await archiveRow();
      assert.equal(first.source_rows, "10005");
      assert.equal(first.source_sha256, original.source_sha256);
      assert.equal(first.remaining_rows, "5");
      assert.deepEqual(
        {
          source_rows: first.remaining_rows,
          source_sha256: first.remaining_sha256,
        },
        await fingerprint(),
      );
      assert.equal(await prune(), 5);
      const last = await archiveRow();
      assert.equal(last.source_rows, "10005");
      assert.equal(last.remaining_rows, "0");
      assert.equal(last.remaining_sha256, (await fingerprint()).source_sha256);
      assert.equal(await prune(), 0);
    });

    it("retains late inserts and same-count changed source values", async () => {
      await insert(2);
      await receipt();
      await insert(1, "public", start, "late");
      assert.equal(await prune(), 0);
      assert.equal(await count(), 3);
      await control.query(
        `DELETE FROM ${schema}.rpc_usage_events WHERE event_id=md5('latepublic1')::uuid`,
      );
      await control.query(
        `UPDATE ${schema}.rpc_usage_events SET latency_ms='-0'::float8`,
      );
      assert.equal(await prune(), 0);
      assert.equal(await count(), 2);
      assert.equal((await archiveRow()).remaining_rows, "2");
    });

    it("fingerprints raw JSON identities and exact signed-zero bits", async () => {
      await insert(1);
      const original = await fingerprint();
      await control.query(
        `UPDATE ${schema}.rpc_usage_events SET network_key=$1`,
        ['"f\\u0069nney"'],
      );
      const quoted = await fingerprint();
      assert.notEqual(quoted.source_sha256, original.source_sha256);
      await control.query(
        `UPDATE ${schema}.rpc_usage_events SET attempts='-0'::float8`,
      );
      const negative = await fingerprint();
      await control.query(
        `UPDATE ${schema}.rpc_usage_events SET attempts='0'::float8`,
      );
      assert.notEqual(
        (await fingerprint()).source_sha256,
        negative.source_sha256,
      );
    });

    it("keeps a receipt day with rows newer than the retention cutoff", async () => {
      await insert(1);
      await insert(1, "public", start + 13 * 3600000, "later");
      await receipt();
      assert.equal(await prune(10000, start + 12 * 3600000), 1);
      assert.equal(await count(), 1);
      assert.equal((await archiveRow()).remaining_rows, "1");
      assert.equal(await prune(), 1);
    });

    it("rolls source deletion and remaining receipt back together", async () => {
      await insert(4);
      const original = await receipt();
      await control.query("BEGIN");
      try {
        assert.equal(await prune(2), 2);
        assert.equal(await count(), 2);
      } finally {
        await control.query("ROLLBACK");
      }
      assert.equal(await count(), 4);
      assert.equal(
        (await archiveRow()).remaining_sha256,
        original.source_sha256,
      );
      assert.equal((await archiveRow()).remaining_rows, "4");
    });

    it("replays an original receipt after partial pruning without changing its identity", async () => {
      await insert(4);
      const original = await receipt();
      assert.equal(await prune(2), 2);
      await control.query(
        `SELECT ${schema}.rpc_usage_record_archive($1,$2,$3,$4,$5,$6)`,
        [
          day,
          original.source_rows,
          original.source_sha256,
          table,
          "123",
          cutoff + 1,
        ],
      );
      assert.equal((await archiveRow()).remaining_rows, "2");
      await assert.rejects(
        control.query(
          `SELECT ${schema}.rpc_usage_record_archive($1,$2,$3,$4,$5,$6)`,
          [
            day,
            original.source_rows,
            original.source_sha256,
            table,
            "124",
            cutoff,
          ],
        ),
        /identity differs/,
      );
    });

    it("accepts concurrent identical first receipts after the unique-key wait", async () => {
      await insert(2);
      const one = new Client({
        connectionString,
        statement_timeout: 5000,
        application_name: "rpc-receipt-one",
      });
      const two = new Client({
        connectionString,
        statement_timeout: 5000,
        application_name: "rpc-receipt-two",
      });
      await one.connect();
      await two.connect();
      try {
        await one.query("BEGIN");
        await two.query("BEGIN");
        await one.query(`LOCK TABLE ${schema}.rpc_usage_events IN SHARE MODE`);
        await two.query(`LOCK TABLE ${schema}.rpc_usage_events IN SHARE MODE`);
        const source = await receipt(day, one);
        const second = two.query(
          `SELECT ${schema}.rpc_usage_record_archive($1,$2,$3,$4,$5,$6)`,
          [day, source.source_rows, source.source_sha256, table, "123", cutoff],
        );
        const settled = second.then(() => undefined);
        await waitForLock("rpc-receipt-two");
        await one.query("COMMIT");
        await settled;
        await two.query("COMMIT");
        assert.equal((await archiveRow()).source_rows, "2");
      } finally {
        await one.query("ROLLBACK");
        await two.query("ROLLBACK");
        await one.end();
        await two.end();
      }
    });

    it("serializes concurrent pruning against the remaining receipt", async () => {
      await insert(10);
      await receipt();
      const one = new Client({
        connectionString,
        statement_timeout: 5000,
        application_name: "rpc-prune-one",
      });
      const two = new Client({
        connectionString,
        statement_timeout: 5000,
        application_name: "rpc-prune-two",
      });
      await one.connect();
      await two.connect();
      try {
        await one.query("BEGIN");
        await two.query("BEGIN");
        assert.equal(await prune(5, cutoff, one), 5);
        const second = prune(5, cutoff, two);
        await waitForLock("rpc-prune-two");
        await one.query("COMMIT");
        assert.equal(await second, 5);
        await two.query("COMMIT");
        assert.equal(await count(), 0);
        assert.equal((await archiveRow()).remaining_rows, "0");
      } finally {
        await one.query("ROLLBACK");
        await two.query("ROLLBACK");
        await one.end();
        await two.end();
      }
    });

    it("rotates past eight stale days so later qualified rows cannot starve", async () => {
      for (let offset = 0; offset < 9; offset++) {
        const at = start + offset * 86400000;
        await insert(1, "public", at, String(offset));
        await receipt(new Date(at).toISOString().slice(0, 10));
      }
      await control.query(
        `UPDATE ${schema}.rpc_usage_events SET latency_ms=13 WHERE occurred_at<$1`,
        [start + 8 * 86400000],
      );
      assert.equal(await prune(10000, start + 10 * 86400000), 0);
      assert.equal(await prune(10000, start + 10 * 86400000), 1);
      assert.equal(await count(), 8);
    });

    it("refuses public pruning when its durable cursor is missing", async () => {
      await insert(2);
      await receipt();
      await control.query(`DELETE FROM ${schema}.rpc_usage_prune_state`);
      try {
        await assert.rejects(prune(), /cursor is missing/);
      } finally {
        await control.query(
          `INSERT INTO ${schema}.rpc_usage_prune_state(singleton) VALUES(true)`,
        );
      }
      assert.equal(await count(), 2);
    });

    it("rejects invalid limits, timestamps and pre-lock repeatable snapshots", async () => {
      const invalidBounds: [number | string | null, number][] = [
        [cutoff, 0],
        [cutoff, 10001],
        [-1, 1],
        [null, 1],
        ["9007199254740992", 1],
      ];
      for (const args of invalidBounds)
        await assert.rejects(
          control.query(`SELECT ${schema}.rpc_usage_prune($1,$2)`, args),
          /retention bound/,
        );
      await control.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      try {
        await assert.rejects(prune(), /READ COMMITTED/);
      } finally {
        await control.query("ROLLBACK");
      }
    });
  },
);
