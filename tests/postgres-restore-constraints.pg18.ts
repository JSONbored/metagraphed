import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const url = pg18FixtureUrl();
const admin = new Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const database = `restore_constraints_${randomUUID().replaceAll("-", "")}`;
let db: Client;
let created = false;
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const targets = [
  {
    schema: "jobs",
    table: "cron_policy",
    name: "cron_policy_check",
    fields: ["execution_ms", "lease_ms"],
    type: "integer",
    values: [
      [null, null],
      [null, 0],
      [1, null],
      [0, 2],
      [1, 2],
      [2, 2],
      [3600000, 3600001],
      [3600001, 3600002],
    ],
  },
  {
    schema: "jobs",
    table: "cron_schedules",
    name: "cron_schedules_check",
    fields: ["cursor_ms", "start_at_ms"],
    type: "bigint",
    values: [
      [null, null],
      [null, 0],
      [-2, 0],
      [-1, 0],
      [0, 0],
      ["9007199254740991", 0],
      ["9007199254740992", 0],
      [3, 5],
      [4, 5],
      [5, null],
    ],
  },
  {
    schema: "jobs",
    table: "cron_schedules",
    name: "cron_schedules_check1",
    fields: ["pending_at_ms", "start_at_ms", "cursor_ms"],
    type: "bigint",
    values: [
      [null, null, null],
      [null, 0, 1],
      [-1, 0, 1],
      [0, 0, 1],
      [1, 0, 1],
      [2, 0, 1],
      ["9007199254740991", 0, "9007199254740991"],
      ["9007199254740992", 0, "9007199254740992"],
      [1, null, 2],
      [1, 0, null],
    ],
  },
  {
    schema: "realtime",
    table: "mcp_sessions",
    name: "mcp_sessions_session_key_check",
    fields: ["session_key"],
    type: "text",
    values: [
      [null],
      [JSON.stringify("")],
      [JSON.stringify("a")],
      [JSON.stringify("x".repeat(1022))],
      [JSON.stringify("x".repeat(1023))],
      ["0"],
      ["{}"],
      ["null"],
      ["!"],
      ["oops"],
      [JSON.stringify("é".repeat(511))],
      [JSON.stringify("é".repeat(512))],
    ],
  },
] as const;
interface Definition {
  schema: string;
  table: string;
  name: string;
  definition: string;
}
async function definitions() {
  return (
    await db.query<Definition>(`SELECT n.nspname AS schema,c.relname AS table,co.conname AS name,
    pg_get_constraintdef(co.oid,false) AS definition FROM pg_constraint co
    JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname,c.relname,co.conname) IN
      (('jobs','cron_policy','cron_policy_check'),('jobs','cron_schedules','cron_schedules_check'),
       ('jobs','cron_schedules','cron_schedules_check1'),('realtime','mcp_sessions','mcp_sessions_session_key_check'))
    ORDER BY n.nspname,c.relname,co.conname`)
  ).rows;
}
async function observations(rows: Definition[]) {
  const result: unknown[] = [];
  for (const target of targets) {
    const definition = rows.find(
      (row) =>
        row.schema === target.schema &&
        row.table === target.table &&
        row.name === target.name,
    )!;
    for (const values of target.values) {
      try {
        const parameters = target.fields
          .map((name, index) => `$${index + 1}::${target.type} AS ${name}`)
          .join(",");
        const row = await db.query(
          `WITH candidate AS (SELECT ${parameters}) SELECT ${definition.definition.slice("CHECK ".length)} AS value FROM candidate`,
          [...values],
        );
        result.push({
          constraint: target.name,
          values,
          value: row.rows[0].value,
        });
      } catch (error) {
        result.push({
          constraint: target.name,
          values,
          error: (error as { code?: string }).code,
        });
      }
    }
  }
  return result;
}

describe("restore-stable native constraints", { concurrency: false }, () => {
  before(async () => {
    await admin.connect();
    assert.equal(
      (await admin.query("SHOW server_version_num")).rows[0].server_version_num,
      "180006",
    );
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const isolated = new URL(url);
    isolated.pathname = `/${database}`;
    db = new Client({
      connectionString: isolated.toString(),
      connectionTimeoutMillis: 2000,
      statement_timeout: 5000,
    });
    await db.connect();
    await db.query(migration("0030_cron.sql"));
    await db.query(migration("0032_mcp_sessions.sql"));
  });
  after(async () => {
    try {
      await db?.end();
    } finally {
      try {
        if (created)
          await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });
  it("retains NULL/boundary/error outcomes while stabilizing exact deparsed definitions", async () => {
    const original = await definitions();
    assert.equal(original.length, 4);
    const expected = await observations(original);
    assert(expected.some((row) => (row as { value?: unknown }).value === null));
    assert(expected.some((row) => (row as { value?: unknown }).value === true));
    assert(
      expected.some((row) => (row as { value?: unknown }).value === false),
    );
    assert(
      expected.some((row) => (row as { error?: unknown }).error === "22P02"),
    );
    await db.query(migration("0039_restore_stable_constraints.sql"));
    const stable = await definitions();
    assert.deepEqual(await observations(stable), expected);
    for (const row of stable) {
      assert.notEqual(
        row.definition,
        original.find((old) => old.name === row.name)!.definition,
      );
      await db.query(
        `ALTER TABLE "${row.schema}"."${row.table}" DROP CONSTRAINT "${row.name}", ADD CONSTRAINT "${row.name}" ${row.definition}`,
      );
    }
    assert.deepEqual(await definitions(), stable);
    assert.deepEqual(await observations(await definitions()), expected);
    assert.equal(
      (
        await db.query(`SELECT count(*)::integer AS invalid FROM pg_constraint
      WHERE conrelid IN ('jobs.cron_policy'::regclass,'jobs.cron_schedules'::regclass,'realtime.mcp_sessions'::regclass)
      AND NOT convalidated`)
      ).rows[0].invalid,
      0,
    );
  });
});
