import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type { AppKv } from "../src/app-kv.ts";
import {
  createNativeApiProcess,
  type NativeSource,
  type NativeSourceDefinition,
} from "../src/native-api-process.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const fixtureUrl = pg18FixtureUrl();
const control = new Client({
  connectionString: fixtureUrl.toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 2000,
});
const prefix = `native_api_${process.pid}`;
const schemas = [`${prefix}_left`, `${prefix}_right`, `${prefix}_hidden`];
const role = `${prefix}_role`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const kv: AppKv = {
  async get() {
    return null;
  },
  async put() {},
  async delete() {},
  async list() {
    return { keys: [], list_complete: true };
  },
  async consume() {
    return null;
  },
};
let created = false;
let sequence = 0;

function definition(
  index: number,
  access: NativeSourceDefinition["access"] = "read-write",
): NativeSourceDefinition {
  return {
    name: schemas[index],
    schema: schemas[index],
    owner: fixtureUrl.username,
    relations: ["items"],
    access,
  };
}

async function fixture(sources: NativeSourceDefinition[], maxConnections = 2) {
  const applicationName = `${prefix}_${++sequence}`;
  const connection = new URL(fixtureUrl);
  connection.username = role;
  connection.password = "native-fixture-only";
  connection.searchParams.set("application_name", applicationName);
  let handles!: ReadonlyMap<string, NativeSource>;
  const runtime = await createNativeApiProcess({
    postgres: {
      connectionString: connection.toString(),
      maxConnections,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 1000,
      statementTimeoutMillis: 2000,
      onIdleError(error) {
        throw error;
      },
    },
    maxRequests: 2,
    maxJobs: 1,
    drainTimeoutMillis: 2000,
    sources,
    kv: { control: kv, oauthPending: kv },
    onBackgroundError(error) {
      throw error;
    },
    async compose(providers) {
      handles = providers.sources;
      const application = {
        async fetch() {
          return new Response("ready");
        },
        async scheduled() {},
        async queue() {},
      };
      return {
        environment: {},
        application,
        authorization: { provider: application },
        async directory() {
          return null;
        },
      };
    },
  });
  return { runtime, handles, applicationName };
}

async function connectionCount(applicationName: string) {
  const result = await control.query<{ count: string }>(
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1",
    [applicationName],
  );
  return Number(result.rows[0].count);
}

async function assertConnectionsClosed(applicationName: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await connectionCount(applicationName)) === 0) return;
    await delay(25);
  }
  assert.equal(await connectionCount(applicationName), 0);
}

describe(
  "native source composition against PostgreSQL 18.6",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await control.query("BEGIN");
      try {
        await control.query(
          `CREATE ROLE ${quote(role)} LOGIN PASSWORD 'native-fixture-only'`,
        );
        for (const [index, schema] of schemas.entries()) {
          await control.query(`CREATE SCHEMA ${quote(schema)}`);
          await control.query(
            `CREATE TABLE ${quote(schema)}.items (id integer PRIMARY KEY, value bigint NOT NULL)`,
          );
          await control.query(
            `INSERT INTO ${quote(schema)}.items VALUES (1, $1)`,
            [index + 100],
          );
          await control.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE ON ${quote(schema)}.items TO ${quote(role)}`,
          );
        }
        await control.query(
          `GRANT USAGE ON SCHEMA ${quote(schemas[0])}, ${quote(schemas[1])} TO ${quote(role)}`,
        );
        await control.query("COMMIT");
        created = true;
      } catch (error) {
        await control.query("ROLLBACK");
        throw error;
      }
    });

    after(async () => {
      try {
        if (created) {
          for (const schema of schemas)
            await control.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
          await control.query(`DROP ROLE ${quote(role)}`);
        }
      } finally {
        await control.end();
      }
    });

    it("selects each declared schema on pooled connections and closes them", async () => {
      const { runtime, handles, applicationName } = await fixture([
        definition(0),
        definition(1),
      ]);
      const left = handles.get(schemas[0])!;
      const right = handles.get(schemas[1])!;
      try {
        assert.deepEqual(
          await Promise.all([
            left.read.first("SELECT value FROM items"),
            right.read.first("SELECT value FROM items"),
          ]),
          [{ value: 100 }, { value: 101 }],
        );
        await left.producer.run(
          "UPDATE items SET value = ? WHERE id = ?",
          [200, 1],
        );
        assert.deepEqual(await right.read.first("SELECT value FROM items"), {
          value: 101,
        });
        assert.deepEqual(await left.sql`SELECT value FROM items`, [
          { value: 200 },
        ]);
        await assert.rejects(
          left.producer.transaction([
            { text: "UPDATE items SET value = 300" },
            { text: "INSERT INTO items VALUES (1,400)" },
          ]),
          (error: unknown) => (error as { code?: string }).code === "23505",
        );
        assert.deepEqual(await left.read.first("SELECT value FROM items"), {
          value: 200,
        });
        assert.ok((await connectionCount(applicationName)) > 0);
      } finally {
        await runtime.close();
      }
      await assertConnectionsClosed(applicationName);
    });

    it("enforces read-only SQL even when the login can write that table", async () => {
      const { runtime, handles } = await fixture([definition(1, "read")]);
      const source = handles.get(schemas[1])!;
      try {
        await assert.rejects(
          source.sql.unsafe("UPDATE items SET value = 500"),
          (error: unknown) => (error as { code?: string }).code === "25006",
        );
        await assert.rejects(
          source.transaction((scope) => scope.query("DELETE FROM items")),
          (error: unknown) => (error as { code?: string }).code === "25006",
        );
        await assert.rejects(
          source.producer.run("UPDATE items SET value = 500"),
          /read-only/,
        );
        assert.deepEqual(await source.read.first("SELECT value FROM items"), {
          value: 101,
        });
      } finally {
        await runtime.close();
      }
    });

    it("keeps a reused connection's temporary relation behind the declared schema", async () => {
      const { runtime, handles } = await fixture([definition(0)], 1);
      const source = handles.get(schemas[0])!;
      try {
        const expected = await source.read.first("SELECT value FROM items");
        await source.transaction(async (scope) => {
          await scope.run("CREATE TEMPORARY TABLE items (value bigint)");
          await scope.run("INSERT INTO pg_temp.items VALUES (9999)");
        });
        assert.deepEqual(
          await source.read.first("SELECT value FROM items"),
          expected,
        );
        assert.deepEqual(
          await source.read.first("SELECT value FROM pg_temp.items"),
          { value: 9999 },
        );
      } finally {
        await runtime.close();
      }
    });

    it("requires schema USAGE in addition to table privileges and cleans failed startup", async () => {
      const tableSelect = await control.query<{ allowed: boolean }>(
        "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
        [role, `${schemas[2]}.items`],
      );
      assert.equal(tableSelect.rows[0].allowed, true);
      const nextName = `${prefix}_${sequence + 1}`;
      await assert.rejects(
        fixture([definition(2, "read")]),
        /not ready for items/,
      );
      await assertConnectionsClosed(nextName);
    });

    it("refuses missing relations and wrong source owners before exposing a process", async () => {
      for (const source of [
        { ...definition(0), relations: ["absent"] },
        { ...definition(0), owner: "different_owner" },
      ]) {
        const nextName = `${prefix}_${sequence + 1}`;
        await assert.rejects(fixture([source]), /not ready/);
        await assertConnectionsClosed(nextName);
      }
    });
  },
);
