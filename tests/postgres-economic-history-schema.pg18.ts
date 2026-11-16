import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const names = [
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "subnet_identity",
  "subnet_identity_history",
  "subnet_ownership",
  "subnet_ownership_history",
  "subnet_lifecycle",
  "subnet_burn_history",
  "subnet_deregistration_daily",
  "subnet_emission_enabled_history",
  "chain_concentration_daily",
  "treasury_readings",
  "compute_declarations",
  "tao_usd_index",
  "revenue_observations",
  "revenue_probe_failures",
  "emission_flow_watch",
  "emission_gate_param_history",
  "attribution_candidates",
  "attribution_sweeps",
];
const booleanColumns = new Set([
  "registration_allowed",
  "commit_reveal_enabled",
  "liquid_alpha_enabled",
  "subnet_is_active",
  "transfers_enabled",
  "bonds_reset_enabled",
  "user_liquidity_enabled",
  "owner_cut_enabled",
  "owner_cut_auto_lock_enabled",
  "predates_capture",
  "enabled",
  "previous_enabled",
  "found",
  "is_set",
]);
const identityInserts = {
  subnet_hyperparams_history:
    "INSERT INTO app.subnet_hyperparams_history(id,netuid,observed_at,hyperparams_hash) VALUES ($1,1,1,$2)",
  subnet_identity_history:
    "INSERT INTO app.subnet_identity_history(id,netuid,block_number,observed_at,identity_hash) VALUES ($1,1,1,1,$2)",
  subnet_ownership_history:
    "INSERT INTO app.subnet_ownership_history(id,netuid,owner_hotkey,owner_coldkey,captured_at) VALUES ($1,1,$2,'cold',1)",
  subnet_lifecycle:
    "INSERT INTO app.subnet_lifecycle(id,netuid,event,observed_at,_invalidation_reason) VALUES ($1,1,'registered',1000000000000,$2)",
  subnet_emission_enabled_history:
    "INSERT INTO app.subnet_emission_enabled_history(id,netuid,enabled,observed_at) VALUES ($1,1,true,1)",
  emission_flow_watch:
    "INSERT INTO app.emission_flow_watch(id,item,is_set,observed_at) VALUES ($1,'net_tao_flow_enabled',false,1)",
  emission_gate_param_history:
    "INSERT INTO app.emission_gate_param_history(id,param,source,observed_at) VALUES ($1,$2,'governance',1)",
} satisfies Record<string, string>;
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
    await control.query(migration("0013_economic_history_activate.sql"));
    await control.query("COMMIT");
  } catch (error) {
    await control.query("ROLLBACK");
    throw error;
  }
}

async function insertIdentity(
  name: keyof typeof identityInserts,
  id: number,
  text: string,
) {
  const sql = identityInserts[name];
  await control.query(sql, sql.includes("$2") ? [id, text] : [id]);
}

describe(
  "non-triggered economic-history PostgreSQL schema",
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
      await control.query(migration("0012_economic_history.sql"));
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

    it("preserves all twenty source column lists, types, nullability and explicit indexes", async () => {
      assert.equal(names.length, 20);
      for (const name of names) {
        const expected = source
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => ({
            name: column.name,
            type: booleanColumns.has(String(column.name))
              ? "boolean"
              : (
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
      const explicitIndexes = await control.query(
        "SELECT index_class.relname AS indexname FROM pg_index index_data JOIN pg_class index_class ON index_class.oid=index_data.indexrelid JOIN pg_class table_class ON table_class.oid=index_data.indrelid JOIN pg_namespace namespace ON namespace.oid=table_class.relnamespace WHERE namespace.nspname='app' AND table_class.relname=ANY($1) AND NOT EXISTS (SELECT 1 FROM pg_constraint constraint_data WHERE constraint_data.conindid=index_data.indexrelid) ORDER BY indexname",
        [names],
      );
      assert.equal(expectedIndexes.length, 31);
      assert.deepEqual(
        explicitIndexes.rows.map((row) => row.indexname),
        expectedIndexes,
      );
      assert.equal(
        sourceObjects.filter(
          (item) => item.type === "trigger" && names.includes(item.tbl_name),
        ).length,
        0,
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relname=ANY($1) AND NOT t.tgisinternal",
            [names],
          )
        ).rows[0].n,
        0,
      );
    });

    it("retains exact strings and wide IDs while preserving nullable flags and binary64 observations", async () => {
      const exact =
        '{ "amount": 123456789012345678901234567890, "nul": "\\u0000", "surrogate": "\\ud800", "n": 1.00 }';
      await control.query(
        "INSERT INTO app.compute_declarations VALUES (1,'source','hash',1000000000000,1000000000000,true,'v1',$1,NULL,NULL)",
        [exact],
      );
      assert.equal(
        (await control.query("SELECT miner FROM app.compute_declarations"))
          .rows[0].miner,
        exact,
      );
      await control.query(
        "INSERT INTO app.subnet_identity_history(id,netuid,block_number,observed_at,identity_hash,description) VALUES (9223372036854775807,1,1,1,'hash',$1)",
        [exact],
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT id,description FROM app.subnet_identity_history",
          )
        ).rows[0],
        { id: "9223372036854775807", description: exact },
      );
      await control.query(
        "INSERT INTO app.subnet_hyperparams(netuid,captured_at,registration_allowed,commit_reveal_enabled,bonds_moving_avg_raw) VALUES (1,1,NULL,true,'9007199254740993.0001')",
      );
      assert.deepEqual(
        (
          await control.query(
            "SELECT registration_allowed,commit_reveal_enabled,bonds_moving_avg_raw FROM app.subnet_hyperparams",
          )
        ).rows[0],
        {
          registration_allowed: null,
          commit_reveal_enabled: true,
          bonds_moving_avg_raw: "9007199254740993.0001",
        },
      );
      await control.query(
        "INSERT INTO app.subnet_burn_history VALUES (1,1,'-0'::double precision),(1,2,$1)",
        [0.1],
      );
      const values = (
        await control.query(
          "SELECT burn_tao FROM app.subnet_burn_history ORDER BY observed_at",
        )
      ).rows;
      assert.equal(values[1].burn_tao, 0.1);
      assert.ok(
        Object.is(
          (
            await control.query(
              "SELECT burn_tao FROM app.subnet_burn_history WHERE observed_at=1",
            )
          ).rows[0].burn_tao,
          -0,
        ),
      );
    });

    it("enforces JSON object, found-value and treasury-share constraints without normalizing text", async () => {
      const compute =
        "INSERT INTO app.compute_declarations VALUES (1,'source','hash',1000000000000,1000000000000,$1,NULL,$2,NULL,NULL)";
      for (const [found, miner] of [
        [true, null],
        [false, "{}"],
        [true, "[]"],
        [true, "null"],
        [true, "{"],
      ] as const) {
        await assert.rejects(control.query(compute, [found, miner]));
      }
      await control.query(compute, [false, null]);
      const treasury =
        "INSERT INTO app.treasury_readings(netuid,source_url,read_at_sha,observed_at,first_seen,found,declared_share,treasury_address) VALUES (1,$1,'hash',1000000000000,1000000000000,$2,$3,$4)";
      for (const [found, share, address] of [
        [true, null, null],
        [false, 0.5, null],
        [true, 1.1, null],
        [true, -0.1, null],
      ] as const) {
        await assert.rejects(
          control.query(treasury, ["invalid", found, share, address]),
          { code: "23514" },
        );
      }
      await control.query(treasury, ["source", true, 0.5, null]);
      assert.equal(
        (await control.query("SELECT review_state FROM app.treasury_readings"))
          .rows[0].review_state,
        "candidate",
      );
    });

    it("retains the price-basis, emission-shape, timestamp and source enums", async () => {
      const invalid = [
        "INSERT INTO app.tao_usd_index VALUES (1,1,NULL,'wrapped_onchain_median',NULL,1,'[]')",
        "INSERT INTO app.tao_usd_index VALUES (1,1,1,'insufficient_pools',NULL,1,'[]')",
        "INSERT INTO app.tao_usd_index VALUES (1,1,NULL,'insufficient_pools',NULL,-1,'[]')",
        "INSERT INTO app.emission_flow_watch(item,is_set,observed_at) VALUES ('subnet_ema_tao_flow',true,1)",
        "INSERT INTO app.emission_flow_watch(item,netuid,is_set,ema_block,observed_at) VALUES ('net_tao_flow_enabled',1,true,1,1)",
        "INSERT INTO app.emission_gate_param_history(param,source,observed_at) VALUES ('p','other',1)",
        "INSERT INTO app.subnet_lifecycle(netuid,event,observed_at) VALUES (1,'other',1000000000000)",
        "INSERT INTO app.subnet_deregistration_daily(netuid,snapshot_date,captured_at) VALUES (1,'day',1)",
        "INSERT INTO app.attribution_sweeps VALUES (1,1000000000000,1,2,0,'candidates-found')",
        "INSERT INTO app.revenue_observations VALUES ('s',1,'p','g',1,'c','other','h',1000000000000)",
        "INSERT INTO app.revenue_probe_failures VALUES ('s',1,'reason',1)",
      ];
      for (const sql of invalid)
        await assert.rejects(control.query(sql), { code: "23514" });
      await control.query(
        "INSERT INTO app.tao_usd_index VALUES (1,1,NULL,'insufficient_pools',NULL,0,'[]')",
      );
      await control.query(
        "INSERT INTO app.emission_flow_watch(item,netuid,is_set,ema_block,observed_at) VALUES ('subnet_ema_tao_flow',1,true,1,1)",
      );
      await control.query(
        "INSERT INTO app.attribution_sweeps VALUES (1,1000000000000,2,1,0,'candidates-found')",
      );
    });

    it("keeps source uniqueness across histories and accepts distinct captures", async () => {
      const pairs = [
        [identityInserts.subnet_identity_history, [1, "same"], [2, "same"]],
        [identityInserts.subnet_ownership_history, [1, "same"], [2, "same"]],
        [identityInserts.subnet_hyperparams_history, [1, "same"], [2, "other"]],
        [identityInserts.emission_gate_param_history, [1, "same"], [2, "same"]],
      ] as const;
      for (const [sql, first, duplicate] of pairs) {
        await control.query(sql, [...first]);
        await assert.rejects(control.query(sql, [...duplicate]), {
          code: "23505",
        });
      }
      await control.query(
        "INSERT INTO app.subnet_identity_history(id,netuid,block_number,observed_at,identity_hash) VALUES (3,1,2,2,'different')",
      );
      assert.equal(
        (
          await control.query(
            "SELECT count(*)::integer AS n FROM app.subnet_identity_history",
          )
        ).rows[0].n,
        2,
      );
    });

    it("advances every identity above imported, original and consumed floors without reuse", async () => {
      for (const name of Object.keys(
        identityInserts,
      ) as (keyof typeof identityInserts)[]) {
        await insertIdentity(name, 12, `fixture-${name}`);
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
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.subnet_identity_history_id_seq') AS id",
          )
        ).rows[0].id,
        "32",
      );
    });

    it("refuses exhaustion before any sequence advances and starts empty sequences at one", async () => {
      await control.query(
        "INSERT INTO source_meta.state_sqlite_sequence VALUES ('subnet_hyperparams_history',100),('emission_gate_param_history',9223372036854775807)",
      );
      await assert.rejects(activate(), { code: "22003" });
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.subnet_hyperparams_history_id_seq') AS id",
          )
        ).rows[0].id,
        "1",
      );
      await control.query("TRUNCATE source_meta.state_sqlite_sequence");
      await activate();
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.subnet_hyperparams_history_id_seq') AS id",
          )
        ).rows[0].id,
        "2",
      );
      assert.equal(
        (
          await control.query(
            "SELECT nextval('app.emission_gate_param_history_id_seq') AS id",
          )
        ).rows[0].id,
        "1",
      );
    });
  },
);
