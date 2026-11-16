import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

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
const activation = () =>
  control.query(migration("0036_usage_row_identity_activate.sql"));
const addDaily = (route: string, rowId?: string) =>
  rowId === undefined
    ? control.query(
        "INSERT INTO app.api_key_usage_daily(account_id,day,route) VALUES(42,'2026-11-04',$1) RETURNING source_row_id::text AS id",
        [route],
      )
    : control.query(
        "INSERT INTO app.api_key_usage_daily(account_id,day,route,source_row_id) VALUES(42,'2026-11-04',$1,$2::bigint)",
        [route, rowId],
      );

describe("usage source row identity", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='app'",
        )
      ).rows[0].n,
      0,
      "requires disposable fixture",
    );
  });
  beforeEach(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.query(migration("0010_account_state.sql"));
    await control.query(migration("0033_account_numeric.sql"));
    await control.query(migration("0035_usage_row_identity.sql"));
  });
  after(async () => {
    await control.query("DROP SCHEMA IF EXISTS app CASCADE");
    await control.end();
  });

  it("requires exact distinct imported rowids and continues beyond the source maximum", async () => {
    await assert.rejects(addDaily("missing"), /null value/);
    await addDaily("first", "9");
    await addDaily("second", "5");
    await assert.rejects(addDaily("duplicate", "9"), /unique constraint/);
    await control.query(
      "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape,source_row_id) VALUES('2026-11-04','z','edge',42),('2026-11-04','a','edge',7)",
    );
    await activation();
    assert.equal((await addDaily("native")).rows[0].id, "10");
    assert.equal(
      (
        await control.query(
          "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape) VALUES('2026-11-04','native','edge') RETURNING source_row_id::text AS id",
        )
      ).rows[0].id,
      "43",
    );
    assert.deepEqual(
      (
        await control.query(
          "SELECT route FROM app.api_key_usage_daily ORDER BY source_row_id",
        )
      ).rows,
      [{ route: "second" }, { route: "first" }, { route: "native" }],
    );
  });

  it("rolls back newly activated defaults, sequences and indexes together", async () => {
    await addDaily("source", "9007199254740993");
    await control.query("BEGIN");
    await activation();
    await assert.rejects(control.query("SELECT 1/0"), /division by zero/);
    await control.query("ROLLBACK");
    assert.equal(
      (
        await control.query(
          "SELECT identity_generation FROM information_schema.columns WHERE table_schema='app' AND table_name='api_key_usage_daily' AND column_name='source_row_id'",
        )
      ).rows[0].identity_generation,
      null,
    );
    assert.equal(
      (
        await control.query(
          "SELECT pg_get_serial_sequence('app.api_key_usage_daily','source_row_id') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.equal(
      (
        await control.query(
          "SELECT to_regclass('app.idx_api_key_usage_source_order') AS name",
        )
      ).rows[0].name,
      null,
    );
    assert.deepEqual(
      (
        await control.query(
          "SELECT source_row_id::text AS id FROM app.api_key_usage_daily",
        )
      ).rows,
      [{ id: "9007199254740993" }],
    );
    await activation();
    assert.equal((await addDaily("native")).rows[0].id, "9007199254740994");
  });

  it("never reuses deleted rowids and refuses int64 exhaustion without wrapping", async () => {
    await addDaily("source", "9223372036854775806");
    await activation();
    assert.equal((await addDaily("last")).rows[0].id, "9223372036854775807");
    await control.query(
      "DELETE FROM app.api_key_usage_daily WHERE route='last'",
    );
    await assert.rejects(addDaily("overflow"), /maximum value/);
    assert.equal(
      (
        await control.query(
          "SELECT count(*)::int AS n FROM app.api_key_usage_daily",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await control.query(
          "SELECT seqcycle FROM pg_sequence WHERE seqrelid=pg_get_serial_sequence('app.api_key_usage_daily','source_row_id')::regclass",
        )
      ).rows[0].seqcycle,
      false,
    );
  });

  it("starts above empty or exclusively nonpositive imported identities", async () => {
    await addDaily("negative", "-9223372036854775808");
    await activation();
    assert.equal((await addDaily("native")).rows[0].id, "1");
    assert.equal(
      (
        await control.query(
          "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape) VALUES('2026-11-04','native','edge') RETURNING source_row_id::text AS id",
        )
      ).rows[0].id,
      "1",
    );
  });

  it("refuses already exhausted source identities before creating either sequence", async () => {
    await control.query(
      "INSERT INTO app.api_usage_rollup(day,route_family,cost_shape,source_row_id) VALUES('2026-11-04','source','edge',9223372036854775807)",
    );
    await assert.rejects(activation(), /no next bigint value/);
    for (const table of ["api_key_usage_daily", "api_usage_rollup"])
      assert.equal(
        (
          await control.query(
            "SELECT pg_get_serial_sequence($1,'source_row_id') AS name",
            [`app.${table}`],
          )
        ).rows[0].name,
        null,
      );
  });
});
