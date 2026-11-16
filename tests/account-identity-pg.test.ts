import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgAccountIdentitySql } from "../src/account-identity-pg.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

test("native identity SQL preserves parameter values, numeric result types and statement custody", async () => {
  const statements: { text: string; values?: unknown[] }[] = [];
  let active = false;
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(callback, options) {
      assert.deepEqual(options, { isolation: "read committed" });
      assert.equal(active, false);
      active = true;
      try {
        return await callback({
          async run(text) {
            statements.push({ text });
            return { changes: 0 };
          },
          async query<Row>(text: string, values?: unknown[]) {
            statements.push({ text, values });
            return [
              {
                id: "9007199254740993",
                owner_id: 42,
                account_id: null,
                tier: "42",
                key_id: "opaque",
              },
            ] as Row[];
          },
          async first() {
            return null;
          },
        });
      } finally {
        active = false;
      }
    },
  };
  const sql = createPgAccountIdentitySql(runtime);
  const rows = await sql<
    Record<string, unknown>
  >`SELECT id FROM rpc_accounts WHERE id=${0.1} AND ss58=${"opaque"}`;
  assert.equal(active, false);
  assert.deepEqual(statements, [
    { text: "SET LOCAL search_path = pg_catalog, app, pg_temp" },
    {
      text: "SELECT id FROM rpc_accounts WHERE id=($1::numeric) AND ss58=($2)",
      values: [
        "0.1000000000000000055511151231257827021181583404541015625",
        "opaque",
      ],
    },
  ]);
  assert.deepEqual(rows, [
    {
      id: 9007199254740992,
      owner_id: 42,
      account_id: null,
      tier: "42",
      key_id: "opaque",
    },
  ]);
  await sql.unsafe("SELECT id FROM rpc_accounts");
  assert.deepEqual(statements.at(-1)?.values, []);
  await sql`SELECT ${1}, ${1e30}, ${-1e30}`;
  assert.equal(
    statements.at(-1)?.text,
    "SELECT ($1::bigint), ($2::numeric), ($3::numeric)",
  );
  assert.throws(() => sql`SELECT ${Infinity}`, /finite/);
});

test("native identity SQL rejects invalid stored numeric outputs", async () => {
  const runtime: Pick<PgStoreRuntime, "transaction"> = {
    async transaction(callback) {
      return callback({
        async run() {
          return { changes: 0 };
        },
        async query<Row>() {
          return [{ id: "not-numeric" }] as Row[];
        },
        async first() {
          return null;
        },
      });
    },
  };
  await assert.rejects(
    createPgAccountIdentitySql(runtime)`SELECT id`,
    /Invalid native account numeric field/,
  );
});

test("native identity SQL refuses malformed result rows", async () => {
  for (const row of [null, 42, []]) {
    const runtime: Pick<PgStoreRuntime, "transaction"> = {
      async transaction(callback) {
        return callback({
          async run() {
            return { changes: 0 };
          },
          async query<Row>() {
            return [row] as Row[];
          },
          async first() {
            return null;
          },
        });
      },
    };
    await assert.rejects(
      createPgAccountIdentitySql(runtime)`SELECT id`,
      /Invalid native account row/,
    );
  }
});
