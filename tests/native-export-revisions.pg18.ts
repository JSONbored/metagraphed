import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { Miniflare } from "miniflare";
import { D1_EXPORT_TABLES } from "../src/d1-export-tables.ts";
import { createPgStateExport } from "../src/pg-state-export.ts";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import { createSqliteDocumentDecoder } from "../src/sqlite-document-decoder.ts";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { createD1Store } from "../src/d1-store.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const base = pg18FixtureUrl();
const database = `native_export_${randomBytes(8).toString("hex")}`;
const target = new URL(base);
target.pathname = `/${database}`;
const client = (url = target) =>
  new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
const admin = client(base),
  db = client();
const runtime = createPgStoreRuntime(
  {
    connectionString: target.toString(),
    maxConnections: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 1000,
    statementTimeoutMillis: 5000,
    onIdleError() {},
  },
  (config) => new Pool(config),
);
const decoder = createSqliteDocumentDecoder({ maxAuditBytes: 524288 });
const fixture = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let d1: D1Database;
const sql = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
const dependencies = Object.keys(D1_EXPORT_TABLES).flatMap((family) =>
  ["neurons", "neuron_daily", "account_position_daily"].includes(family)
    ? [`${family}_documents`, `${family}_members`].map((table) => ({
        family,
        table,
      }))
    : [{ family, table: family }],
);
const native = createPgStateExport(
  {
    schema: "app",
    access: "read-write",
    relations: [
      "native_export_revisions",
      ...dependencies.map(({ table }) => table),
    ],
    transaction: runtime.transaction,
  },
  decoder,
  { identity: "urn:metagraphed:export:fixture" },
);
type Reply = {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  revision: number;
  next_cursor: (string | number)[] | null;
  row_keys: unknown[][];
  projection_sha256: string;
  day_revisions: boolean;
  days: unknown[];
};
function losslessBits(rows: unknown[][]): unknown[][] {
  return rows.map((row) =>
    row.map((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        !("storage" in value) ||
        value.storage !== "real" ||
        !("value" in value)
      )
        return value;
      // The projection contract encodes REAL as a round-trippable decimal. It
      // does not require one platform's printf spelling. Compare all 64 bits;
      // text and INTEGER encodings still compare byte-for-byte.
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleBE(Number(value.value));
      return { storage: "real", bits: bytes.toString("hex") };
    }),
  );
}
function request(body: unknown, token = "fixture") {
  return new Request("https://example.invalid/api/v1/internal/state-export", {
    method: "POST",
    headers: { "x-state-export-token": token },
    body: JSON.stringify(body),
  });
}
async function exported(body: unknown, selected: boolean) {
  const response = await handleD1StateExport(
    request(body),
    selected
      ? { STATE_EXPORT_SECRET: "fixture", NATIVE_STATE_EXPORT: native }
      : {
          STATE_EXPORT_SECRET: "fixture",
          D1_EXPORT_REVISIONS: "enabled",
          D1_STATE: d1,
          D1_STATE_TABLES: Object.keys(D1_EXPORT_TABLES).join(","),
        },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json<Reply>();
}

describe(
  "native archive export revision ownership",
  { concurrency: false },
  () => {
    before(async () => {
      await admin.connect();
      assert.equal(
        (await admin.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      await admin.query(`CREATE DATABASE ${database}`);
      await db.connect();
      for (const name of [
        "0007_registry_health.sql",
        "0012_economic_history.sql",
        "0014_account_observations.sql",
        "0022_closed_day_revisions.sql",
        "0024_neuron_documents.sql",
        "0040_native_export_revisions.sql",
      ])
        await db.query(sql(name));
      // A partially loaded schema must fail before any family is activated.
      await db.query("BEGIN");
      await db.query(
        "ALTER TABLE app.account_balances RENAME TO missing_account_balances",
      );
      await assert.rejects(
        db.query(sql("0041_native_export_revisions_activate.sql")),
        /dependency is missing/,
      );
      await db.query("ROLLBACK");
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM app.native_export_revisions",
          )
        ).rows[0].count,
        "0",
      );
      await db.query(
        "INSERT INTO app.subnet_snapshots(netuid,snapshot_date) VALUES(999,'2020-01-01')",
      );
      await db.query("BEGIN");
      await db.query(sql("0041_native_export_revisions_activate.sql"));
      await db.query("COMMIT");
      d1 = await fixture.getD1Database("DB");
      const objects = JSON.parse(
        readFileSync(
          new URL("../generated/db/d1-schema.json", import.meta.url),
          "utf8",
        ),
      ) as { type: string; sql: string }[];
      for (const type of ["table", "index", "view", "trigger"])
        for (const object of objects.filter((entry) => entry.type === type))
          await d1.prepare(object.sql).run();
      await d1
        .prepare(
          "INSERT INTO archive_export_revisions(table_name,revision) VALUES('__closed_day_revisions_v1',1)",
        )
        .run();
    });

    beforeEach(async () => {
      await db.query("TRUNCATE app.account_balances");
      await db.query("UPDATE app.native_export_revisions SET revision=0");
    });

    after(async () => {
      await runtime.close();
      decoder.close();
      await fixture.dispose();
      await db.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    });

    async function revision(family: string, connection = db): Promise<number> {
      const result = await connection.query(
        "SELECT revision FROM app.native_export_revisions WHERE family=$1",
        [family],
      );
      return Number(result.rows[0]?.revision);
    }

    it("owns the full approved table set and each physical view dependency", async () => {
      const actual = (
        await db.query(
          "SELECT family FROM app.native_export_revisions WHERE strpos(family,'/')=0 ORDER BY family",
        )
      ).rows.map((row) => row.family);
      assert.deepEqual(actual, Object.keys(D1_EXPORT_TABLES).sort());
      for (const { family, table } of dependencies) {
        const trigger = (
          await db.query(
            "SELECT t.tgtype,encode(t.tgargs,'escape') AS args FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname=$1 AND t.tgname='native_export_revision'",
            [table],
          )
        ).rows[0];
        assert.ok(trigger, `${table} has a revision owner`);
        assert.equal(trigger.args, `${family}\\000`);
        assert.equal(trigger.tgtype, 62); // statement-level BEFORE all four mutation kinds
        const before = await revision(family);
        await db.query(`DELETE FROM app.${table} WHERE false`);
        assert.equal(await revision(family), before + 1, table);
      }
    });

    it("commits the source rows and revision together, including concurrent writers", async () => {
      const other = client();
      await other.connect();
      try {
        await Promise.all([
          db.query("INSERT INTO app.account_balances VALUES('one',1,0,1)"),
          other.query("INSERT INTO app.account_balances VALUES('two',2,0,2)"),
        ]);
        assert.equal(await revision("account_balances"), 2);
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::text AS count FROM app.account_balances",
            )
          ).rows[0].count,
          "2",
        );
        await other.query("BEGIN");
        await other.query("DELETE FROM app.account_balances");
        assert.equal(await revision("account_balances"), 2);
        await other.query("ROLLBACK");
        assert.equal(await revision("account_balances"), 2);
        await db.query("TRUNCATE app.account_balances");
        assert.equal(await revision("account_balances"), 3);
      } finally {
        await other.end();
      }
    });

    it("keeps revision and rows coherent in a repeatable-read export snapshot", async () => {
      const writer = client();
      await writer.connect();
      await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        assert.equal(await revision("account_balances"), 0);
        await writer.query(
          "INSERT INTO app.account_balances VALUES('later',3,0,3)",
        );
        assert.equal(
          (
            await db.query(
              "SELECT count(*)::text AS count FROM app.account_balances",
            )
          ).rows[0].count,
          "0",
        );
        assert.equal(await revision("account_balances"), 0);
        await db.query("COMMIT");
        assert.equal(await revision("account_balances"), 1);
      } finally {
        await db.query("ROLLBACK");
        await writer.end();
      }
    });

    it("refuses source writes when their revision owner is missing or exhausted", async () => {
      await db.query("BEGIN");
      await db.query(
        "DELETE FROM app.native_export_revisions WHERE family='account_balances'",
      );
      await assert.rejects(
        db.query("INSERT INTO app.account_balances VALUES('missing',1,0,1)"),
        /owner is incomplete/,
      );
      await db.query("ROLLBACK");
      await db.query(
        "UPDATE app.native_export_revisions SET revision=9007199254740991 WHERE family='account_balances'",
      );
      await assert.rejects(
        db.query("INSERT INTO app.account_balances VALUES('overflow',1,0,1)"),
        /check constraint/,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::text AS count FROM app.account_balances",
          )
        ).rows[0].count,
        "0",
      );
      await db.query(
        "UPDATE app.native_export_revisions SET revision=0 WHERE family='account_balances'",
      );
    });

    it("preserves imported D1 revision records", async () => {
      await db.query(
        "INSERT INTO app.archive_export_revisions VALUES('account_balances',123)",
      );
      await db.query("INSERT INTO app.account_balances VALUES('native',1,0,1)");
      assert.equal(
        (
          await db.query(
            "SELECT revision::text AS revision FROM app.archive_export_revisions WHERE table_name='account_balances'",
          )
        ).rows[0].revision,
        "123",
      );
      assert.equal(await revision("account_balances"), 1);
    });

    it("tracks closed days independently and invalidates imported days on TRUNCATE", async () => {
      assert.equal(await revision("subnet_snapshots/2020-01-01"), 0);
      await db.query(
        "INSERT INTO app.subnet_snapshots(netuid,snapshot_date) VALUES(998,'2020-01-02')",
      );
      assert.equal(await revision("subnet_snapshots/2020-01-01"), 0);
      assert.equal(await revision("subnet_snapshots/2020-01-02"), 1);
      await db.query(
        "UPDATE app.subnet_snapshots SET total_stake_tao=1 WHERE netuid=999",
      );
      assert.equal(await revision("subnet_snapshots/2020-01-01"), 2);
      assert.equal(await revision("subnet_snapshots/2020-01-02"), 1);
      await db.query("TRUNCATE app.subnet_snapshots");
      assert.equal(await revision("subnet_snapshots/2020-01-01"), 3);
      assert.equal(await revision("subnet_snapshots/2020-01-02"), 3);
    });

    it("preserves every approved schema and empty-table response", async () => {
      for (const { table } of dependencies)
        await db.query(`TRUNCATE app.${table} CASCADE`);
      for (const table of Object.keys(D1_EXPORT_TABLES)) {
        const expected = await exported({ table, kind: "schema" }, false);
        const actual = await exported({ table, kind: "schema" }, true);
        assert.deepEqual(actual.columns, expected.columns, table);
        assert.equal(actual.day_revisions, expected.day_revisions, table);
        const exactExpected = await exported(
          { table, kind: "schema", encoding: "lossless-v1" },
          false,
        );
        const exactActual = await exported(
          { table, kind: "schema", encoding: "lossless-v1" },
          true,
        );
        assert.deepEqual(exactActual.columns, exactExpected.columns, table);
        const columns = expected.columns.map((column) => column.name);
        const rows = await exported({ table, kind: "rows", columns }, true);
        assert.deepEqual(rows.rows, [], table);
        assert.equal(rows.next_cursor, null, table);
      }
    });

    it("preserves exact scalar cells and wide keys on a relational table", async () => {
      await d1.prepare("DELETE FROM account_balances").run();
      await d1
        .prepare("INSERT INTO account_balances VALUES(?,?,?,?)")
        .bind("é-account", 0.1, -0.2, "9007199254740993")
        .run();
      await db.query("INSERT INTO app.account_balances VALUES($1,$2,$3,$4)", [
        "é-account",
        0.1,
        -0.2,
        "9007199254740993",
      ]);
      const schema = await exported(
        { table: "account_balances", kind: "schema", encoding: "lossless-v1" },
        false,
      );
      for (const encoding of [undefined, "lossless-v1"]) {
        const input = {
          table: "account_balances",
          kind: "rows",
          columns: schema.columns.map((column) => column.name),
          encoding,
        };
        const expected = await exported(input, false),
          actual = await exported(input, true);
        assert.deepEqual(
          encoding ? losslessBits(actual.rows) : actual.rows,
          encoding ? losslessBits(expected.rows) : expected.rows,
        );
        if (encoding) {
          assert.deepEqual(actual.row_keys, expected.row_keys);
          assert.match(actual.projection_sha256, /^[a-f0-9]{64}$/);
          assert.notEqual(actual.projection_sha256, expected.projection_sha256);
        }
      }
    });

    it("uses canonical first-member document reads for all three dynamic views", async () => {
      const stamp = 1793836800000,
        day = "2020-01-01";
      for (const table of [
        "neurons",
        "neuron_daily",
        "account_position_daily",
      ]) {
        const account = table === "account_position_daily",
          member = account ? "k61636374" : "7";
        const body = `{"${member}":{"rank":0.1,"stake_tao":9007199254740993,"active":true,"captured_at":${stamp},"axon":{"first":1},"coldkey":"c\\u0000k"},"${member}":{"rank":9}}`;
        const selectedDay = table === "neurons" ? "" : day;
        await d1
          .prepare(
            `INSERT INTO ${table}_documents(netuid,day,shard,stamp,payload) VALUES(?,?,?,?,jsonb(?))`,
          )
          .bind(1, selectedDay, 0, stamp, body)
          .run();
        const binary = await d1
          .prepare(
            `SELECT hex(payload) AS value FROM ${table}_documents WHERE netuid=1`,
          )
          .first<string>("value");
        await db.query(
          `INSERT INTO app.${table}_documents(netuid,day,shard,stamp,payload) VALUES($1,$2,$3,$4,$5)`,
          [1, selectedDay, 0, stamp, Buffer.from(binary!, "hex")],
        );
        const names = account
          ? ["account", "netuid", "snapshot_date", "shard"]
          : [
              "netuid",
              "uid",
              "hotkey",
              "coldkey",
              ...(table === "neurons" ? [] : ["snapshot_date"]),
              "shard",
            ];
        const values = account
          ? ["acct", 1, day, 0]
          : [1, 7, "h", "c", ...(table === "neurons" ? [] : [day]), 0];
        await d1
          .prepare(
            `INSERT INTO ${table}_members(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
          )
          .bind(...values)
          .run();
        await db.query(
          `INSERT INTO app.${table}_members(${names.join(",")}) VALUES(${names.map((_, index) => `$${index + 1}`).join(",")})`,
          values,
        );
        const schema = await exported({ table, kind: "schema" }, false);
        for (const encoding of [undefined, "lossless-v1"]) {
          const input = {
            table,
            kind: "rows",
            columns: schema.columns.map((column) => column.name),
            encoding,
          };
          const expected = await exported(input, false),
            actual = await exported(input, true);
          assert.deepEqual(
            encoding ? losslessBits(actual.rows) : actual.rows,
            encoding ? losslessBits(expected.rows) : expected.rows,
            table,
          );
          if (encoding)
            assert.deepEqual(actual.row_keys, expected.row_keys, table);
        }
      }
    });

    it("resumes bounded pages and rejects a writer racing between pages", async () => {
      await d1.prepare("DELETE FROM account_balances").run();
      await d1
        .prepare(
          "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2002) INSERT INTO account_balances SELECT printf('%05d',i),0.1,0,1 FROM n",
        )
        .run();
      await db.query(
        "INSERT INTO app.account_balances SELECT lpad(i::text,5,'0'),0.1,0,1 FROM generate_series(1,2002) n(i)",
      );
      const input = {
        table: "account_balances",
        kind: "rows",
        columns: ["ss58", "free_tao"],
      };
      const expected = await exported(input, false),
        actual = await exported(input, true);
      assert.deepEqual(actual.rows, expected.rows);
      assert.equal(actual.rows.length, 2000);
      assert.deepEqual(actual.next_cursor, expected.next_cursor);
      const final = await exported(
        { ...input, revision: actual.revision, cursor: actual.next_cursor },
        true,
      );
      assert.equal(final.rows.length, 2);
      await db.query(
        "INSERT INTO app.account_balances VALUES('changed',1,0,1)",
      );
      const stale = await native.export({
        ...input,
        revision: actual.revision,
        cursor: actual.next_cursor,
      });
      assert.equal(stale.status, 409);
      await createD1Store(d1, ["account_balances"]).run(
        "INSERT INTO account_balances VALUES('changed',1,0,1)",
      );
      const sourceStale = await handleD1StateExport(
        request({
          ...input,
          revision: expected.revision,
          cursor: expected.next_cursor,
        }),
        {
          STATE_EXPORT_SECRET: "fixture",
          D1_EXPORT_REVISIONS: "enabled",
          D1_STATE: d1,
          D1_STATE_TABLES: "account_balances",
        },
      );
      assert.equal(sourceStale.status, 409);
    });

    it("requires authentication and complete native revision ownership", async () => {
      const input = {
        table: "account_balances",
        kind: "rows",
        columns: ["ss58"],
      };
      const unauthorized = await handleD1StateExport(request(input, "wrong"), {
        STATE_EXPORT_SECRET: "fixture",
        NATIVE_STATE_EXPORT: native,
      });
      assert.equal(unauthorized.status, 401);
      const invalid = await handleD1StateExport(request(input), {
        STATE_EXPORT_SECRET: "fixture",
        NATIVE_STATE_EXPORT: {},
      });
      assert.equal(invalid.status, 503);
      await db.query(
        "ALTER TABLE app.account_balances DISABLE TRIGGER native_export_revision",
      );
      try {
        assert.equal((await native.export(input)).status, 503);
      } finally {
        await db.query(
          "ALTER TABLE app.account_balances ENABLE TRIGGER native_export_revision",
        );
      }
    });

    it("preserves populated rows in every relational export family", async () => {
      const views = new Set([
        "neurons",
        "neuron_daily",
        "account_position_daily",
      ]);
      const overrides: Record<string, unknown> = {
        "revenue_observations.provenance": "probe-derived",
        "emission_flow_watch.item": "net_tao_flow_enabled",
        "emission_gate_param_history.source": "governance",
        "subnet_lifecycle.event": "registered",
        "nominator_positions.source": "alpha",
        "surfaces.kind": "subnet-api",
        "surfaces.authority": "community",
        "surfaces.review_state": "community-submitted",
        "subnets.source": "registry",
        "tao_usd_index.price_basis": "insufficient_pools",
        "self_health_daily.component": "api",
        "surface_uptime_daily.status": "up",
      };
      const order = [
        "providers",
        "subnets",
        "surfaces",
        ...Object.keys(D1_EXPORT_TABLES).filter(
          (name) =>
            !["providers", "subnets", "surfaces"].includes(name) &&
            !views.has(name),
        ),
      ];
      for (const table of order) {
        await d1.prepare(`DELETE FROM ${table}`).run();
        await db.query(`DELETE FROM app.${table}`);
        const schema = (
          await d1.prepare(`PRAGMA table_info(${table})`).all<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
            dflt_value: string | null;
          }>()
        ).results;
        const columns = schema.filter(
          (column) =>
            !column.name.startsWith("_") &&
            column.notnull &&
            column.dflt_value === null,
        );
        const values = columns.map((column) => {
          const key = `${table}.${column.name}`;
          if (Object.hasOwn(overrides, key)) return overrides[key];
          if (column.type === "INTEGER")
            return /(_at|first_seen|computed_at)$/.test(column.name)
              ? 1793836800000
              : column.name === "found"
                ? 0
                : 1;
          if (column.type === "REAL") return 0.125;
          if (["day", "snapshot_date"].includes(column.name))
            return "2020-01-01";
          if (["overlay", "card", "additional"].includes(column.name))
            return "{}";
          if (["latency_samples", "pools"].includes(column.name)) return "[]";
          if (column.name.includes("url"))
            return "https://example.invalid/fixture";
          if (column.name.includes("hash") || column.name.includes("sha"))
            return "a".repeat(64);
          return "fixture";
        });
        await d1
          .prepare(
            `INSERT INTO ${table}(${columns.map((column) => column.name).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
          )
          .bind(...values)
          .run();
        const names = schema
          .filter((column) => !column.name.startsWith("_"))
          .map((column) => column.name);
        const row = (await d1
          .prepare(`SELECT ${names.join(",")} FROM ${table}`)
          .first<Record<string, unknown>>())!;
        const types = (
          await db.query(
            "SELECT attname AS name,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped",
            [`app.${table}`],
          )
        ).rows;
        const encoded = names.map((name) =>
          row[name] === null
            ? null
            : types.find((column) => column.name === name)?.type === "boolean"
              ? Boolean(row[name])
              : row[name],
        );
        await db.query(
          `INSERT INTO app.${table}(${names.join(",")}) VALUES(${names.map((_, index) => `$${index + 1}`).join(",")})`,
          encoded,
        );
        const approved = (
          await exported({ table, kind: "schema" }, false)
        ).columns.map((column) => column.name);
        for (const encoding of [undefined, "lossless-v1"]) {
          const input = { table, kind: "rows", columns: approved, encoding };
          const expected = await exported(input, false),
            actual = await exported(input, true);
          assert.deepEqual(
            encoding ? losslessBits(actual.rows) : actual.rows,
            encoding ? losslessBits(expected.rows) : expected.rows,
            table,
          );
          assert.equal(actual.rows.length, 1, table);
        }
      }
    });

    it("holds a stable native page against concurrent TRUNCATE", async () => {
      await db.query("INSERT INTO app.account_balances VALUES('stable',1,0,1)");
      const writer = client();
      await writer.connect();
      await writer.query("SET lock_timeout='50ms'");
      const checked = createPgStateExport(
        {
          schema: "app",
          access: "read-write",
          relations: [
            "native_export_revisions",
            ...dependencies.map(({ table }) => table),
          ],
          transaction: (callback, options) =>
            runtime.transaction(async (scope) => {
              const result = await callback(scope);
              await assert.rejects(
                writer.query("TRUNCATE app.account_balances"),
                /lock timeout/,
              );
              return result;
            }, options),
        },
        decoder,
        { identity: "urn:metagraphed:export:truncate-fixture" },
      );
      try {
        const response = await checked.export({
          table: "account_balances",
          kind: "rows",
          columns: ["ss58"],
        });
        assert.equal(response.status, 200);
        assert.deepEqual((await response.json<Reply>()).rows, [["stable"]]);
        await writer.query("TRUNCATE app.account_balances");
        assert.deepEqual(
          (
            await exported(
              { table: "account_balances", kind: "rows", columns: ["ss58"] },
              true,
            )
          ).rows,
          [],
        );
      } finally {
        await writer.end();
      }
    });

    it("compares exceptional text cursors as source UTF-8 bytes", async () => {
      await d1.prepare("DELETE FROM account_balances").run();
      for (const address of ["a", "b", "é"]) {
        await d1
          .prepare("INSERT INTO account_balances VALUES(?,1,0,1)")
          .bind(address)
          .run();
        await db.query("INSERT INTO app.account_balances VALUES($1,1,0,1)", [
          address,
        ]);
      }
      for (const cursor of ["a\0tail", "a\ud800", "\ud800"]) {
        const base = {
          table: "account_balances",
          kind: "rows",
          columns: ["ss58"],
          cursor: [cursor],
        };
        const a = await exported({ table: base.table, kind: "revision" }, true);
        const b = await exported(
          { table: base.table, kind: "revision" },
          false,
        );
        assert.deepEqual(
          (await exported({ ...base, revision: a.revision }, true)).rows,
          (await exported({ ...base, revision: b.revision }, false)).rows,
        );
      }
    });

    it("preserves SQLite numeric cursor affinity for ASCII and Unicode whitespace", async () => {
      await d1.prepare("DELETE FROM subnet_ownership").run();
      await db.query("DELETE FROM app.subnet_ownership");
      for (const key of [0, 1, 2]) {
        await d1
          .prepare("INSERT INTO subnet_ownership VALUES(?,'h','c',1)")
          .bind(key)
          .run();
        await db.query(
          "INSERT INTO app.subnet_ownership VALUES($1,'h','c',1)",
          [key],
        );
      }
      const table = "subnet_ownership";
      const expectedRevision = (
        await exported({ table, kind: "revision" }, false)
      ).revision;
      const actualRevision = (await exported({ table, kind: "revision" }, true))
        .revision;
      for (const cursor of [
        "\t1\r",
        "\u00a01",
        "1\u00a0",
        "\u20001",
        "\ufeff1",
        "1\0tail",
      ]) {
        const body = {
          table,
          kind: "rows",
          columns: ["netuid"],
          cursor: [cursor],
        };
        assert.deepEqual(
          (await exported({ ...body, revision: actualRevision }, true)).rows,
          (await exported({ ...body, revision: expectedRevision }, false)).rows,
          JSON.stringify(cursor),
        );
      }
    });

    it("bounds stored documents and day inventories before acknowledging them", async () => {
      const constraint = (
        await db.query(
          "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='app.neurons_documents'::regclass AND pg_get_constraintdef(oid) LIKE '%octet_length%'",
        )
      ).rows[0];
      assert.ok(constraint);
      const name = '"' + String(constraint.conname).replaceAll('"', '""') + '"';
      await db.query(
        `ALTER TABLE app.neurons_documents DROP CONSTRAINT ${name}`,
      );
      try {
        await db.query("UPDATE app.neurons_documents SET payload=$1", [
          Buffer.alloc(524289),
        ]);
        assert.equal(
          (
            await native.export({
              table: "neurons",
              kind: "rows",
              columns: ["rank"],
            })
          ).status,
          503,
        );
        await db.query("DELETE FROM app.neurons_documents");
      } finally {
        await db.query(
          `ALTER TABLE app.neurons_documents ADD CONSTRAINT ${name} ${constraint.definition}`,
        );
      }
      await db.query("TRUNCATE app.subnet_snapshots");
      await db.query(
        "INSERT INTO app.subnet_snapshots(netuid,snapshot_date) SELECT 1,lpad(i::text,5,'0')||repeat('x',2000) FROM generate_series(1,1100) n(i)",
      );
      assert.equal(
        (await native.export({ table: "subnet_snapshots", kind: "days" }))
          .status,
        413,
      );
      await db.query("TRUNCATE app.subnet_snapshots");
    });

    it("preserves wide lossless cursors and rejects unbounded rows", async () => {
      await d1.prepare("DELETE FROM account_identity_history").run();
      await db.query("DELETE FROM app.account_identity_history");
      for (const id of ["9007199254740993", "9007199254740994"]) {
        await d1
          .prepare(
            "INSERT INTO account_identity_history(id,account,observed_at,identity_hash) VALUES(?, ?, ?, ?)",
          )
          .bind(id, id, 1, id)
          .run();
        await db.query(
          "INSERT INTO app.account_identity_history(id,account,observed_at,identity_hash) VALUES($1,$2,1,$3)",
          [id, id, id],
        );
      }
      const schema = await exported(
        { table: "account_identity_history", kind: "schema" },
        false,
      );
      const input = {
        table: "account_identity_history",
        kind: "rows",
        columns: schema.columns.map((column) => column.name),
        encoding: "lossless-v1",
        cursor: ["9007199254740993"],
      };
      const a = await exported({ table: input.table, kind: "revision" }, true),
        b = await exported({ table: input.table, kind: "revision" }, false);
      const actual = await exported({ ...input, revision: a.revision }, true),
        expected = await exported({ ...input, revision: b.revision }, false);
      assert.deepEqual(actual.rows, expected.rows);
      assert.equal(actual.rows.length, 1);
      await db.query("DELETE FROM app.account_identity");
      await db.query(
        "INSERT INTO app.account_identity(account,name,captured_at) VALUES('large',$1,1)",
        ["x".repeat(2 * 1024 * 1024)],
      );
      assert.equal(
        (
          await native.export({
            table: "account_identity",
            kind: "rows",
            columns: ["name"],
          })
        ).status,
        413,
      );
    });

    it("matches non-finite REAL refusal and schema-drift refusal", async () => {
      await d1.prepare("DELETE FROM account_balances").run();
      await d1
        .prepare("INSERT INTO account_balances VALUES('infinite',1e999,0,1)")
        .run();
      await db.query(
        "INSERT INTO app.account_balances VALUES('infinite','Infinity'::float8,0,1)",
      );
      const input = {
        table: "account_balances",
        kind: "rows",
        columns: ["free_tao"],
      };
      assert.deepEqual(
        (await exported(input, true)).rows,
        (await exported(input, false)).rows,
      );
      const schema = await exported(
        { table: input.table, kind: "schema" },
        false,
      );
      assert.equal(
        (
          await native.export({
            ...input,
            columns: schema.columns.map((column) => column.name),
            encoding: "lossless-v1",
          })
        ).status,
        503,
      );
      await db.query(
        "ALTER TABLE app.account_balances ADD COLUMN unapproved text",
      );
      try {
        assert.equal(
          (await native.export({ table: input.table, kind: "schema" })).status,
          503,
        );
      } finally {
        await db.query(
          "ALTER TABLE app.account_balances DROP COLUMN unapproved",
        );
      }
    });
  },
);
