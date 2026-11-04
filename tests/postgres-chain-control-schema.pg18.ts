import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "blocks_head",
  "chain_detail_blocks",
  "chain_detail_account_events",
  "chain_detail_chain_events",
  "chain_detail_extrinsics",
  "chain_detail_payload_chunks",
  "sync_dead_letters",
  "iceberg_catalog_namespaces",
  "iceberg_catalog_tables",
];
const sourceObjects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}[];
const source = new DatabaseSync(":memory:");
source.exec("PRAGMA foreign_keys=ON");
const control = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
let ownApp = false;

async function activate() {
  await control.query("BEGIN");
  try {
    await control.query(migration("0017_chain_control_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

describe(
  "chain detail and catalog PostgreSQL schema",
  { concurrency: false },
  () => {
    before(async () => {
      await control.connect();
      assert.equal(
        (await control.query("SHOW server_version_num")).rows[0]
          .server_version_num,
        "180006",
      );
      ownApp =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='app'",
          )
        ).rowCount === 0;
      await control.query(migration("0016_chain_control.sql"));
      for (const object of sourceObjects.filter(
        (item) => item.type === "table" && names.includes(item.name),
      ))
        source.exec(object.sql);
      for (const object of sourceObjects.filter(
        (item) => item.type !== "table" && names.includes(item.tbl_name),
      ))
        source.exec(object.sql);
    });
    beforeEach(async () => {
      await control.query(
        "ALTER TABLE app.iceberg_catalog_tables DROP CONSTRAINT IF EXISTS iceberg_catalog_tables_namespace_fkey",
      );
      await control.query(
        `TRUNCATE ${names.map((name) => `app.${name}`).join(",")}`,
      );
    });
    after(async () => {
      try {
        await control.query("DROP TABLE IF EXISTS app.iceberg_catalog_tables");
        for (const name of names.filter(
          (name) => name !== "iceberg_catalog_tables",
        ))
          await control.query(`DROP TABLE IF EXISTS app.${name}`);
        if (ownApp) await control.query("DROP SCHEMA app");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves all nine source column definitions and sixteen explicit indexes", async () => {
      assert.equal(names.length, 9);
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type: ["success", "economics_complete"].includes(
              String(column.name),
            )
              ? "boolean"
              : ({ INTEGER: "bigint", TEXT: "text" } as Record<string, string>)[
                  String(column.type)
                ],
            nullable: !(column.notnull || column.pk),
          }));
        const actual = await control.query(
          "SELECT column_name AS name,data_type AS type,is_nullable='YES' AS nullable FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        );
        assert.deepEqual(actual.rows, expected, name);
      }
      const expectedIndexes = sourceObjects
        .filter(
          (item) => item.type === "index" && names.includes(item.tbl_name),
        )
        .map((item) => item.name)
        .sort();
      const actualIndexes = await control.query(
        "SELECT index_class.relname AS indexname FROM pg_index index_data JOIN pg_class index_class ON index_class.oid=index_data.indexrelid JOIN pg_class table_class ON table_class.oid=index_data.indrelid JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace WHERE namespace.nspname='app' AND table_class.relname=ANY($1) AND NOT EXISTS (SELECT 1 FROM pg_constraint constraint_data WHERE constraint_data.conindid=index_data.indexrelid) ORDER BY indexname",
        [names],
      );
      assert.equal(expectedIndexes.length, 16);
      assert.deepEqual(
        actualIndexes.rows.map((row) => row.indexname),
        expectedIndexes,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_constraint WHERE conrelid='app.iceberg_catalog_tables'::regclass AND contype='f'",
          )
        ).rows[0].n,
        0,
      );
    });

    it("keeps original text and wide block IDs with nullable booleans and source defaults", async () => {
      const exact =
        '{ "number": 123456789012345678901234567890, "escaped": "\\u0000\\ud800", "n": 1.00 }';
      await control.query(
        "INSERT INTO app.chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at,native_transfer_tao) VALUES (9223372036854775807,'ÄAB',1,2,3,1,1,$1)",
        ["9007199254740993.00000000000000000001"],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT block_number,native_transfer_tao,economics_complete,subnet_ids,lower(block_hash) AS hash FROM app.chain_detail_blocks",
          )
        ).rows[0],
        {
          block_number: "9223372036854775807",
          native_transfer_tao: "9007199254740993.00000000000000000001",
          economics_complete: false,
          subnet_ids: "[]",
          hash: "Äab",
        },
      );
      assert.equal(
        source.prepare("SELECT lower('ÄAB') AS hash").get()?.hash,
        "Äab",
      );
      await control.query(
        "INSERT INTO app.chain_detail_extrinsics(block_number,extrinsic_index,success,call_args,observed_at) VALUES (-1,0,NULL,$1,1),(-1,1,false,$1,1),(-1,2,true,$1,1)",
        [exact],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT success FROM app.chain_detail_extrinsics ORDER BY extrinsic_index",
          )
        ).rows.map((row) => row.success),
        [null, false, true],
      );
      assert.ok(
        (
          await control.query(
            "SELECT call_args FROM app.chain_detail_extrinsics",
          )
        ).rows.every((row) => row.call_args === exact),
      );
      await control.query(
        "INSERT INTO app.chain_detail_chain_events VALUES (1,0,'pallet','method',$1,'phase',NULL,1)",
        [exact],
      );
      assert.equal(
        (await control.query("SELECT args FROM app.chain_detail_chain_events"))
          .rows[0].args,
        exact,
      );
    });

    it("keeps the distinct character and byte bounds and source hash/part checks", async () => {
      const hash = "a".repeat(64);
      await control.query(
        "INSERT INTO app.chain_detail_payload_chunks VALUES ($1,11,repeat('λ',1986668))",
        [hash],
      );
      assert.equal(
        (
          await control.query(
            "SELECT length(data)::integer AS n FROM app.chain_detail_payload_chunks",
          )
        ).rows[0].n,
        1986668,
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_detail_payload_chunks VALUES ($1,10,repeat('λ',1986669))",
          [hash],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_detail_payload_chunks VALUES ($1,12,'x')",
          [hash],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_detail_payload_chunks VALUES ('short',0,'x')",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_detail_payload_chunks VALUES ($1,11,'other')",
          [hash],
        ),
        { code: "23505" },
      );
      await control.query(
        "INSERT INTO app.sync_dead_letters VALUES ('message',$1,'json',repeat('λ',87382),1)",
        [hash],
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.sync_dead_letters VALUES ('large',$1,'json',repeat('λ',87383),1)",
          [hash],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.sync_dead_letters VALUES ('',$1,'json','{}',1)",
          [hash],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.sync_dead_letters VALUES (repeat('x',257),$1,'json','{}',1)",
          [hash],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.sync_dead_letters VALUES ('wrong',$1,'other','{}',1)",
          [hash],
        ),
        { code: "23514" },
      );
    });

    it("validates any JSON value without changing the stored serialization", async () => {
      const exact =
        '{ "wide": 123456789012345678901234567890, "escaped": "\\u0000\\ud800", "n": 1.00 }';
      for (const [index, value] of [
        exact,
        "null",
        "true",
        "[]",
        '"text"',
      ].entries()) {
        await control.query(
          "INSERT INTO app.iceberg_catalog_namespaces VALUES ($1,$2)",
          [`ns-${index}`, value],
        );
      }
      assert.deepEqual(
        (
          await control.query(
            "SELECT properties FROM app.iceberg_catalog_namespaces ORDER BY namespace",
          )
        ).rows.map((row) => row.properties),
        [exact, "null", "true", "[]", '"text"'],
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.iceberg_catalog_namespaces VALUES ('invalid','{')",
        ),
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.iceberg_catalog_tables VALUES ('ns','table','location',NULL,'{')",
        ),
      );
      await control.query(
        "INSERT INTO app.iceberg_catalog_tables VALUES ('ns-0','table','location',NULL,$1)",
        [exact],
      );
      assert.equal(
        (
          await control.query(
            "SELECT metadata_summary FROM app.iceberg_catalog_tables",
          )
        ).rows[0].metadata_summary,
        exact,
      );
    });

    it("validates the namespace foreign key after load and preserves restricted deletion and rollback", async () => {
      await control.query(
        "INSERT INTO app.iceberg_catalog_tables VALUES ('ns','table','location',NULL,'{}')",
      );
      await assert.rejects(activate(), { code: "23503" });
      await control.query(
        "INSERT INTO app.iceberg_catalog_namespaces VALUES ('ns','{}')",
      );
      await activate();
      await assert.rejects(
        control.query(
          "INSERT INTO app.iceberg_catalog_tables VALUES ('missing','other','location',NULL,'{}')",
        ),
        { code: "23503" },
      );
      await assert.rejects(
        control.query(
          "DELETE FROM app.iceberg_catalog_namespaces WHERE namespace='ns'",
        ),
        { code: "23503" },
      );
      await control.query("BEGIN");
      await control.query(
        "DELETE FROM app.iceberg_catalog_tables WHERE namespace='ns'",
      );
      await control.query(
        "DELETE FROM app.iceberg_catalog_namespaces WHERE namespace='ns'",
      );
      await control.query("ROLLBACK");
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.iceberg_catalog_tables",
          )
        ).rows[0].n,
        1,
      );
      source.exec(
        "INSERT INTO iceberg_catalog_namespaces VALUES ('ns','{}'); INSERT INTO iceberg_catalog_tables VALUES ('ns','table','location',NULL,'{}')",
      );
      assert.throws(() =>
        source.exec(
          "DELETE FROM iceberg_catalog_namespaces WHERE namespace='ns'",
        ),
      );
    });
  },
);
