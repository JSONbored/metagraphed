import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "rpc_accounts",
  "github_accounts",
  "api_keys",
  "api_key_blocks",
  "api_key_usage_daily",
  "api_quota_daily",
  "api_usage_rollup",
  "api_usage_rollup_batches",
  "chain_alert_triggers",
  "chain_alert_deliveries",
  "watch_push_subscriptions",
];
const identityInserts = {
  rpc_accounts:
    "INSERT INTO app.rpc_accounts(id,ss58,created_at) VALUES ($1,$2,1)",
  github_accounts:
    "INSERT INTO app.github_accounts(id,github_user_id,github_login,created_at) VALUES ($1,$1,$2,1)",
  api_keys:
    "INSERT INTO app.api_keys(id,owner_contact,created_at) VALUES ($1,$2,1)",
  api_key_blocks:
    "INSERT INTO app.api_key_blocks(id,account_id,reason_code,blocked_at,unblocked_at) VALUES ($1,$1,$2,1,2)",
  chain_alert_triggers:
    "INSERT INTO app.chain_alert_triggers(id,owner_token,channel,destination,created_at,updated_at) VALUES ($1,$2,'webhook','https://example.com/hook',1,1)",
  chain_alert_deliveries:
    "INSERT INTO app.chain_alert_deliveries(id,trigger_id,delivered_at,success,response_snippet) VALUES ($1,12,1,true,$2)",
  watch_push_subscriptions:
    "INSERT INTO app.watch_push_subscriptions(id,address,endpoint,p256dh,auth,created_at) VALUES ($1,$2,$2,'fixture-public','fixture-auth',1)",
} satisfies Record<string, string>;
const sourceObjects = JSON.parse(
  readFileSync(
    new URL("../generated/db/d1-schema.json", import.meta.url),
    "utf8",
  ),
) as { type: string; name: string; tbl_name: string; sql: string }[];
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
const activation = migration("0011_account_state_activate.sql");
let ownApp = false;
let ownMetadata = false;

async function activate() {
  await control.query("BEGIN");
  try {
    await control.query(activation);
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

describe(
  "account, usage and alert PostgreSQL schema",
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
      await control.query(migration("0010_account_state.sql"));
      for (const object of sourceObjects.filter(
        (item) => item.type === "table" && names.includes(item.name),
      )) {
        source.exec(object.sql);
      }
      for (const object of sourceObjects.filter(
        (item) => item.type !== "table" && names.includes(item.tbl_name),
      )) {
        source.exec(object.sql);
      }
    });
    beforeEach(async () => {
      await control.query(
        "ALTER TABLE app.chain_alert_deliveries DROP CONSTRAINT IF EXISTS chain_alert_deliveries_trigger_id_fkey",
      );
      await control.query(
        `TRUNCATE ${names.map((name) => `app.${name}`).join(",")},source_meta.state_sqlite_sequence RESTART IDENTITY`,
      );
      source.exec("DELETE FROM chain_alert_deliveries");
      for (const name of names.filter(
        (name) => name !== "chain_alert_deliveries",
      ))
        source.exec(`DELETE FROM ${name}`);
    });
    after(async () => {
      try {
        await control.query("DROP TABLE IF EXISTS app.chain_alert_deliveries");
        for (const name of names.filter(
          (name) => name !== "chain_alert_deliveries",
        )) {
          await control.query(`DROP TABLE IF EXISTS app.${name}`);
        }
        if (ownApp) await control.query("DROP SCHEMA app");
        if (ownMetadata) await control.query("DROP SCHEMA source_meta CASCADE");
      } finally {
        source.close();
        await control.end();
      }
    });

    it("preserves every source column and explicit index in the load phase", async () => {
      assert.equal(names.length, 11);
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((row) => row.name);
        const actual = await control.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name=$1 ORDER BY ordinal_position",
          [name],
        );
        assert.deepEqual(
          actual.rows.map((row) => row.column_name),
          expected,
          name,
        );
      }
      const expectedIndexes = sourceObjects
        .filter(
          (item) => item.type === "index" && names.includes(item.tbl_name),
        )
        .map((item) => item.name)
        .sort();
      const actualIndexes = await control.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname='app' AND tablename=ANY($1) AND indexname LIKE 'idx_%' ORDER BY indexname",
        [names],
      );
      assert.equal(expectedIndexes.length, 14);
      assert.deepEqual(
        actualIndexes.rows.map((row) => row.indexname),
        expectedIndexes,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_constraint WHERE conrelid='app.chain_alert_deliveries'::regclass AND contype='f'",
          )
        ).rows[0].n,
        0,
      );
    });

    it("keeps exact IDs, nullable values, text and explicit boolean defaults", async () => {
      const exact = '{ "value": "λ\\u0000\\ud800", "n": 1.00 }';
      await control.query(identityInserts.rpc_accounts, [
        "9223372036854775807",
        "fixture-address",
      ]);
      assert.equal(
        (await control.query("SELECT id FROM app.rpc_accounts")).rows[0].id,
        "9223372036854775807",
      );
      await control.query(
        "INSERT INTO app.api_keys(id,owner_contact,secret_hash,created_at) VALUES (-7,'fixture',NULL,1),(-8,'fixture',NULL,1)",
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT id,prefix,secret_hash FROM app.api_keys ORDER BY id",
          )
        ).rows,
        [
          { id: "-8", prefix: null, secret_hash: null },
          { id: "-7", prefix: null, secret_hash: null },
        ],
      );
      await control.query(identityInserts.chain_alert_triggers, [12, exact]);
      const trigger = (
        await control.query(
          "SELECT owner_token,active,name,match_count FROM app.chain_alert_triggers",
        )
      ).rows[0];
      assert.deepEqual(trigger, {
        owner_token: exact,
        active: true,
        name: null,
        match_count: "0",
      });
      await control.query(
        "INSERT INTO app.api_usage_rollup_batches(batch_id,sha256,expires_at) VALUES ('batch',$1,1)",
        ["a".repeat(64)],
      );
      assert.equal(
        (
          await control.query(
            "SELECT applied FROM app.api_usage_rollup_batches",
          )
        ).rows[0].applied,
        false,
      );
      await control.query(
        "INSERT INTO app.chain_alert_deliveries(id,trigger_id,delivered_at,success,response_snippet) VALUES (-1,12,1,false,$1)",
        [exact],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT success,response_snippet FROM app.chain_alert_deliveries",
          )
        ).rows[0],
        { success: false, response_snippet: exact },
      );
    });

    it("preserves account-kind separation, partial uniqueness and source check constraints", async () => {
      await control.query(
        "INSERT INTO app.api_quota_daily VALUES (1,'day',3,1,'rpc'),(1,'day',4,1,'github')",
      );
      await control.query(
        "INSERT INTO app.api_key_usage_daily VALUES (1,'day','route',3,0,'rpc'),(1,'day','route',4,0,'github')",
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.api_quota_daily",
          )
        ).rows[0].n,
        2,
      );
      await control.query(
        "INSERT INTO app.api_key_blocks(id,account_id,reason_code,blocked_at) VALUES (1,1,'fixture',1)",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.api_key_blocks(id,account_id,reason_code,blocked_at) VALUES (2,1,'fixture',1)",
        ),
        { code: "23505" },
      );
      await control.query("UPDATE app.api_key_blocks SET unblocked_at=2");
      await control.query(
        "INSERT INTO app.api_key_blocks(id,account_id,reason_code,blocked_at) VALUES (2,1,'fixture',3)",
      );
      await control.query(
        "INSERT INTO app.api_keys(id,prefix,owner_contact,created_at,unkey_key_id) VALUES (1,'prefix','fixture',1,'opaque-id')",
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.api_keys(id,prefix,owner_contact,created_at) VALUES (2,'prefix','fixture',1)",
        ),
        { code: "23505" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.api_keys(id,owner_contact,created_at,unkey_key_id) VALUES (3,'fixture',1,'opaque-id')",
        ),
        { code: "23505" },
      );
      await control.query(identityInserts.watch_push_subscriptions, [
        1,
        "endpoint",
      ]);
      await assert.rejects(
        control.query(identityInserts.watch_push_subscriptions, [
          2,
          "endpoint",
        ]),
        { code: "23505" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.api_quota_daily VALUES (2,'day',0,1,'other')",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.api_usage_rollup_batches VALUES ('bad','short',1,false)",
        ),
        { code: "23514" },
      );
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_alert_triggers(owner_token,channel,destination,created_at,updated_at) VALUES ('fixture','other','fixture',1,1)",
        ),
        { code: "23514" },
      );
    });

    it("loads exact fractional and wide quota source values before native auth bootstrap", async () => {
      await control.query(
        "INSERT INTO app.api_quota_daily(account_kind,account_id,day,units_spent,updated_at) VALUES ('rpc',1e30,'day',0.1000000000000000055511151231257827021181583404541015625,1)",
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT account_id::text AS account_id,units_spent::text AS units_spent FROM app.api_quota_daily",
          )
        ).rows,
        [
          {
            account_id: "1000000000000000000000000000000",
            units_spent:
              "0.1000000000000000055511151231257827021181583404541015625",
          },
        ],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='app' AND table_name='api_quota_daily' AND column_name IN ('account_id','units_spent') ORDER BY column_name",
          )
        ).rows,
        [
          { column_name: "account_id", data_type: "numeric" },
          { column_name: "units_spent", data_type: "numeric" },
        ],
      );
    });

    it("reconciles all seven sequences above imported, legacy and consumed values", async () => {
      for (const [name, sql] of Object.entries(identityInserts)) {
        await control.query(sql, [12, `fixture-${name}`]);
        await control.query(
          "INSERT INTO source_meta.state_sqlite_sequence VALUES ($1,20),($1,18)",
          [name],
        );
        await control.query(`SELECT setval('app.${name}_id_seq',30)`);
      }
      await activate();
      for (const name of Object.keys(identityInserts)) {
        assert.equal(
          (await control.query(`SELECT nextval('app.${name}_id_seq') AS id`))
            .rows[0].id,
          "31",
          name,
        );
      }
    });

    it("starts empty sequences at one and never reuses an already consumed value", async () => {
      await control.query("SELECT nextval('app.rpc_accounts_id_seq')");
      await activate();
      assert.equal(
        (await control.query("SELECT nextval('app.rpc_accounts_id_seq') AS id"))
          .rows[0].id,
        "2",
      );
      for (const name of Object.keys(identityInserts).filter(
        (name) => name !== "rpc_accounts",
      )) {
        assert.equal(
          (await control.query(`SELECT nextval('app.${name}_id_seq') AS id`))
            .rows[0].id,
          "1",
          name,
        );
      }
    });

    it("refuses any exhausted sequence before advancing earlier sequences or adding the foreign key", async () => {
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('rpc_accounts',100),('watch_push_subscriptions',9223372036854775807)",
      );
      await assert.rejects(activate(), { code: "22003" });
      assert.equal(
        (await control.query("SELECT nextval('app.rpc_accounts_id_seq') AS id"))
          .rows[0].id,
        "1",
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_constraint WHERE conrelid='app.chain_alert_deliveries'::regclass AND contype='f'",
          )
        ).rows[0].n,
        0,
      );
    });

    it("refuses orphaned imported deliveries and then enforces source cascade and rollback behavior", async () => {
      await control.query(
        "INSERT INTO app.chain_alert_deliveries(id,trigger_id,delivered_at,success) VALUES (1,12,1,true)",
      );
      await assert.rejects(activate(), { code: "23503" });
      await control.query(identityInserts.chain_alert_triggers, [
        12,
        "fixture",
      ]);
      await activate();
      await assert.rejects(
        control.query(
          "INSERT INTO app.chain_alert_deliveries(trigger_id,delivered_at,success) VALUES (99,1,true)",
        ),
        { code: "23503" },
      );
      await control.query("BEGIN");
      await control.query("DELETE FROM app.chain_alert_triggers WHERE id=12");
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.chain_alert_deliveries",
          )
        ).rows[0].n,
        0,
      );
      await control.query("ROLLBACK");
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.chain_alert_deliveries",
          )
        ).rows[0].n,
        1,
      );
      await control.query("DELETE FROM app.chain_alert_triggers WHERE id=12");
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.chain_alert_deliveries",
          )
        ).rows[0].n,
        0,
      );
      source.exec(
        "INSERT INTO chain_alert_triggers(id,owner_token,channel,destination,created_at,updated_at) VALUES (12,'fixture','webhook','fixture',1,1)",
      );
      source.exec(
        "INSERT INTO chain_alert_deliveries(id,trigger_id,delivered_at,success) VALUES (1,12,1,1)",
      );
      source.exec("DELETE FROM chain_alert_triggers WHERE id=12");
      assert.equal(
        source.prepare("SELECT count(*) AS n FROM chain_alert_deliveries").get()
          ?.n,
        0,
      );
    });
  },
);
