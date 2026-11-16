import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const db = new Client({
  connectionString: pg18FixtureUrl().toString(),
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const migration = (name: string) =>
  readFileSync(
    new URL(`../migrations/postgres/${name}`, import.meta.url),
    "utf8",
  );
describe(
  "account numeric source-load compatibility",
  { concurrency: false },
  () => {
    before(async () => {
      await db.connect();
      assert.equal(
        (await db.query("SHOW server_version_num")).rows[0].server_version_num,
        "180006",
      );
      await db.query(migration("0010_account_state.sql"));
      await db.query(migration("0033_account_numeric.sql"));
    });
    after(async () => {
      await db.query("DROP SCHEMA IF EXISTS app CASCADE");
      await db.end();
    });
    it("widens only the seven intended source columns before auth bootstrap", async () => {
      const columns = (
        await db.query(
          "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='app' AND data_type='numeric' ORDER BY table_name,column_name",
        )
      ).rows;
      assert.deepEqual(columns, [
        { table_name: "api_key_blocks", column_name: "account_id" },
        { table_name: "api_key_usage_daily", column_name: "account_id" },
        { table_name: "api_key_usage_daily", column_name: "rejected_count" },
        { table_name: "api_key_usage_daily", column_name: "request_count" },
        { table_name: "api_quota_daily", column_name: "account_id" },
        { table_name: "api_quota_daily", column_name: "units_spent" },
        { table_name: "api_usage_rollup", column_name: "keyed_count" },
        { table_name: "api_usage_rollup", column_name: "request_count" },
        { table_name: "github_accounts", column_name: "github_user_id" },
      ]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('auth','jobs')",
          )
        ).rows[0].n,
        0,
      );
    });
    it("retains exact identifier values and counter storage classes", async () => {
      const wide = "1000000000000000019884624838656";
      const fraction =
        "0.1000000000000000055511151231257827021181583404541015625";
      await db.query(
        "INSERT INTO app.github_accounts(github_user_id,github_login,created_at) VALUES($1,'fixture',0)",
        [wide],
      );
      await db.query(
        "INSERT INTO app.api_key_blocks(account_id,reason_code,blocked_at) VALUES($1,'abuse_manual',0)",
        [wide],
      );
      await db.query(
        "INSERT INTO app.api_key_usage_daily(account_id,day,route,request_count,rejected_count) VALUES($1,'day','route',9007199254740993.0,'-Infinity')",
        [fraction],
      );
      await db.query(
        "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape,request_count,keyed_count) VALUES('day','route','edge','Infinity',$1)",
        [fraction],
      );
      assert.equal(
        (
          await db.query(
            "SELECT github_user_id::text AS n FROM app.github_accounts",
          )
        ).rows[0].n,
        wide,
      );
      assert.equal(
        (await db.query("SELECT account_id::text AS n FROM app.api_key_blocks"))
          .rows[0].n,
        wide,
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT account_id::text AS id,request_count::text AS requests,rejected_count::text AS rejected FROM app.api_key_usage_daily",
          )
        ).rows[0],
        { id: fraction, requests: "9007199254740993.0", rejected: "-Infinity" },
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT request_count::text AS requests,keyed_count::text AS keyed FROM app.api_usage_rollup",
          )
        ).rows[0],
        { requests: "Infinity", keyed: fraction },
      );
      await assert.rejects(
        db.query(
          "INSERT INTO app.api_key_usage_daily(account_id,day,route) VALUES($1,'day','route')",
          [fraction + "0"],
        ),
        { code: "23505" },
      );
    });
  },
);
