import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "account_balances",
  "account_balances_passes",
  "account_identity",
  "account_identity_history",
  "hotkey_alpha",
  "hotkey_alpha_passes",
  "nominator_positions",
  "nominator_positions_passes",
  "nominator_scan_receipts",
  "validator_nominator_counts",
  "validator_nominator_counts_passes",
  "_migration_capture_governance",
  "_migration_capture_governance_phase",
  "_migration_user_state",
  "_migration_user_state_phase",
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
let ownMetadata = false;

async function activate() {
  await control.query("BEGIN");
  try {
    await control.query(migration("0015_account_observations_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

describe(
  "account observations and migration-ledger PostgreSQL schema",
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
      ownMetadata =
        (
          await control.query(
            "SELECT oid FROM pg_namespace WHERE nspname='source_meta'",
          )
        ).rowCount === 0;
      if (ownMetadata)
        await control.query(migration("0000_source_metadata.sql"));
      await control.query(migration("0014_account_observations.sql"));
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
        `TRUNCATE ${names.map((name) => `app.${name}`).join(",")},source_meta.state_sqlite_sequence RESTART IDENTITY`,
      );
    });
    after(async () => {
      try {
        for (const name of names)
          await control.query(`DROP TABLE IF EXISTS app.${name}`);
        if (ownApp) await control.query("DROP SCHEMA app");
        if (ownMetadata) await control.query("DROP SCHEMA source_meta CASCADE");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves all fifteen source column definitions and ten explicit indexes", async () => {
      assert.equal(names.length, 15);
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type: (
              {
                INTEGER: "bigint",
                REAL: "double precision",
                TEXT: "text",
              } as Record<string, string>
            )[String(column.type)],
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
      assert.equal(expectedIndexes.length, 10);
      assert.deepEqual(
        actualIndexes.rows.map((row) => row.indexname),
        expectedIndexes,
      );
      assert.equal(
        sourceObjects.filter(
          (item) => item.type === "trigger" && names.includes(item.tbl_name),
        ).length,
        0,
      );
    });

    it("preserves exact identity strings, nullable observations and original migration payloads", async () => {
      const exact = "not-json λ '\n { 1.00 \\u0000 \\ud800 }";
      await control.query(
        "INSERT INTO app.account_identity VALUES ('account',NULL,NULL,NULL,NULL,NULL,$1,$1,9223372036854775807)",
        [exact],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT name,description,additional,captured_at FROM app.account_identity",
          )
        ).rows[0],
        {
          name: null,
          description: exact,
          additional: exact,
          captured_at: "9223372036854775807",
        },
      );
      for (const name of [
        "_migration_capture_governance",
        "_migration_user_state",
      ]) {
        await control.query(
          `INSERT INTO app.${name} VALUES ('table','row',$1)`,
          [exact],
        );
        assert.equal(
          (await control.query(`SELECT payload FROM app.${name}`)).rows[0]
            .payload,
          exact,
        );
      }
      for (const name of [
        "_migration_capture_governance_phase",
        "_migration_user_state_phase",
      ]) {
        await control.query(`INSERT INTO app.${name} VALUES (-7,$1)`, [exact]);
        assert.deepEqual(
          (await control.query(`SELECT id,status FROM app.${name}`)).rows[0],
          { id: "-7", status: exact },
        );
      }
      await control.query(
        "INSERT INTO app.nominator_positions(coldkey,hotkey,netuid,share_fraction,captured_at,shares) VALUES ('cold','hot',1,NULL,1,$1)",
        ["9007199254740993.00000000000000000001"],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT share_fraction,shares,source FROM app.nominator_positions",
          )
        ).rows[0],
        {
          share_fraction: null,
          shares: "9007199254740993.00000000000000000001",
          source: "alpha",
        },
      );
      await control.query(
        "INSERT INTO app.account_balances VALUES ('address',0.1,'-0'::double precision,1)",
      );
      const balance = (
        await control.query(
          "SELECT free_tao,reserved_tao FROM app.account_balances",
        )
      ).rows[0];
      assert.equal(balance.free_tao, 0.1);
      assert.ok(Object.is(balance.reserved_tao, -0));
    });

    it("retains pass defaults, composite uniqueness and the positive receipt constraint", async () => {
      for (const name of [
        "account_balances_passes",
        "hotkey_alpha_passes",
        "nominator_positions_passes",
        "validator_nominator_counts_passes",
      ]) {
        await control.query(
          `INSERT INTO app.${name}(captured_at,expected_rows) VALUES (1,10)`,
        );
        assert.deepEqual(
          (
            await control.query(
              `SELECT received_rows,completed_at FROM app.${name}`,
            )
          ).rows[0],
          { received_rows: "0", completed_at: null },
        );
      }
      await control.query(
        "INSERT INTO app.hotkey_alpha VALUES ('hot',1,0.1,1),('hot',2,0.2,1)",
      );
      await assert.rejects(
        control.query("INSERT INTO app.hotkey_alpha VALUES ('hot',1,0.2,2)"),
        { code: "23505" },
      );
      await control.query(
        "INSERT INTO app.nominator_positions(coldkey,hotkey,netuid,captured_at) VALUES ('cold','hot',1,1),('cold','hot',2,1)",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.nominator_positions(coldkey,hotkey,netuid,captured_at) VALUES ('cold','hot',1,2)",
        ),
        { code: "23505" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.nominator_scan_receipts VALUES (1,'cold',0)",
        ),
        { code: "23514" },
      );
      await control.query(
        "INSERT INTO app.nominator_scan_receipts VALUES (1,'cold',1)",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.nominator_scan_receipts VALUES (1,'cold',2)",
        ),
        { code: "23505" },
      );
      await control.query(
        "INSERT INTO app.account_identity_history(id,account,observed_at,identity_hash) VALUES (-4,'account',1,'hash')",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.account_identity_history(id,account,observed_at,identity_hash) VALUES (3,'account',1,'other')",
        ),
        { code: "23505" },
      );
    });

    it("reconciles identity above imported, legacy and consumed values and never moves backward", async () => {
      await control.query(
        "INSERT INTO app.account_identity_history(id,account,observed_at,identity_hash) VALUES (12,'account',1,'hash')",
      );
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('account_identity_history',20),('account_identity_history',18)",
      );
      await control.query(
        "SELECT setval('app.account_identity_history_id_seq',30)",
      );
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.account_identity_history_id_seq') AS id",
          )
        ).rows[0].id,
        "31",
      );
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.account_identity_history_id_seq') AS id",
          )
        ).rows[0].id,
        "32",
      );
    });

    it("refuses an exhausted source floor and starts an empty identity at one", async () => {
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('account_identity_history',9223372036854775807)",
      );
      await assert.rejects(activate(), { code: "22003" });
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.account_identity_history_id_seq') AS id",
          )
        ).rows[0].id,
        "1",
      );
      await control.query("TRUNCATE source_meta.state_sqlite_sequence");
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.account_identity_history_id_seq') AS id",
          )
        ).rows[0].id,
        "2",
      );
    });
  },
);
