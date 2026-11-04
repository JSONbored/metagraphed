import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, after, beforeEach, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { Miniflare } from "miniflare";
import { createPgStoreRuntime } from "../src/pg-store-runtime.ts";
import worker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import { pg18FixtureUrl } from "./helpers/pg18-fixture.ts";

const connectionString = pg18FixtureUrl().toString();
const schema = "native_relational_fixture";
const control = new Client({
  connectionString,
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
});
const runtime = createPgStoreRuntime({
  connectionString,
  maxConnections: 2,
  connectionTimeoutMillis: 2000,
  idleTimeoutMillis: 1000,
  statementTimeoutMillis: 5000,
  onIdleError() {},
}, (config) => new Pool({ ...config, options: `-c search_path=${schema}` }));
const tables = [
  "surface_status",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "account_identity",
  "account_identity_history",
];
const source = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
let ownsSchema = false;
const ctx = { waitUntil() {} } as unknown as ExecutionContext;
const paths = [
  "internal/health-status-live",
  "internal/health-status-live?since=15",
  "internal/health-status-live?since=10.5",
  "internal/health-status-live?since=1e30",
  "subnets/7/hyperparameters",
  "subnets/99/hyperparameters",
  "subnets/7/hyperparameters/history",
  "subnets/1111111111111111168/hyperparameters",
  "subnets/999999999999999999999999999999/hyperparameters",
  "subnets/7/hyperparameters/history?limit=1",
  "subnets/7/hyperparameters/history?limit=1&offset=1",
  "accounts/%C3%A9/identity",
  "accounts/missing/identity",
  "accounts/%00/identity",
  "accounts/%C3%A9/identity-history",
  "accounts/%C3%A9/identity-history?limit=1",
  "accounts/%C3%A9/identity-history?limit=1&offset=1",
  "accounts/%00/identity-history",
];

async function insert(
  table: string,
  row: Record<string, string | number | boolean | null>,
) {
  const names = Object.keys(row);
  const values = Object.values(row);
  await db
    .prepare(
      `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    )
    .bind(
      ...values.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      ),
    )
    .run();
  await control.query(
    `INSERT INTO ${schema}.${table} (${names.join(",")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(",")})`,
    values,
  );
}

async function compare(path: string) {
  const request = new Request(`https://example.com/api/v1/${path}`);
  const sourceEnv = dataApiEnv({ D1_STATE: db, D1_STATE_TABLES: tables.join(",") });
  const nativeEnv = { ...dataApiEnv(), NATIVE_READ_STORE: { tables, store: runtime.read } };
  const expected = await worker.fetch(request.clone(), sourceEnv, ctx);
  const actual = await worker.fetch(request.clone(), nativeEnv, ctx);
  assert.equal(actual.status, expected.status, path);
  const expectedBody = await expected.text();
  assert.equal(await actual.text(), expectedBody, path);
  return JSON.parse(expectedBody);
}

describe("native relational data API parity", { concurrency: false }, () => {
  before(async () => {
    await control.connect();
    assert.equal(
      (await control.query("SHOW server_version_num")).rows[0]
        .server_version_num,
      "180006",
    );
    const exists = await control.query(
      "SELECT 1 FROM pg_namespace WHERE nspname=$1",
      [schema],
    );
    assert.equal(
      exists.rowCount,
      0,
      "Refuse to replace an existing fixture schema",
    );
    ownsSchema = true;
    for (const filename of [
      "0007_registry_health.sql",
      "0012_economic_history.sql",
      "0014_account_observations.sql",
    ]) {
      const sql = readFileSync(
        new URL(`../migrations/postgres/${filename}`, import.meta.url),
        "utf8",
      );
      await control.query(sql.replace(/\bapp\b/g, schema));
    }
    db = await source.getD1Database("DB");
    const objects = JSON.parse(
      readFileSync(
        new URL("../generated/db/d1-schema.json", import.meta.url),
        "utf8",
      ),
    ) as { type: string; name: string; sql: string }[];
    for (const object of objects.filter(
      (row) => row.type === "table" && tables.includes(row.name),
    ))
      await db.prepare(object.sql).run();
  });
  beforeEach(async () => {
    await control.query(
      `TRUNCATE ${tables.map((table) => `${schema}.${table}`).join(",")}`,
    );
    for (const table of tables) await db.prepare(`DELETE FROM ${table}`).run();
  });
  after(async () => {
    await source.dispose();
    await runtime.close();
    if (ownsSchema)
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  });
  it("retains each empty-family cold response", async () => {
    for (const path of paths) await compare(path);
  });
  it("preserves live identity, numeric/boolean hyperparameters, health filters and missing identities", async () => {
    await insert("surface_status", {
      surface_id: "a",
      netuid: 7,
      status: "up",
      last_checked: 10,
      consecutive_failures: 0,
    });
    await insert("surface_status", {
      surface_id: "é",
      status: "down",
      last_checked: 20,
      consecutive_failures: 2,
    });
    await insert("subnet_hyperparams", {
      netuid: 7,
      captured_at: 1793491200000,
      tempo: 12,
      registration_allowed: true,
      commit_reveal_enabled: false,
      min_burn_tao: 0.125,
      weights_version: "9007199254740993",
    });
    await insert("account_identity", {
      account: "é",
      name: "Native identity",
      url: "https://example.com",
      captured_at: 1793491200000,
    });
    await db
      .prepare(
        "INSERT INTO surface_status(surface_id,netuid,last_checked) VALUES('wide',9007199254740993,9007199254740993)",
      )
      .run();
    await control.query(
      `INSERT INTO ${schema}.surface_status(surface_id,netuid,last_checked) VALUES('wide',9007199254740993,9007199254740993)`,
    );
    await db
      .prepare(
        "INSERT INTO subnet_hyperparams(netuid,captured_at,tempo) VALUES(1111111111111111168,1793491200000,99)",
      )
      .run();
    await control.query(
      `INSERT INTO ${schema}.subnet_hyperparams(netuid,captured_at,tempo) VALUES(1111111111111111168,1793491200000,99)`,
    );
    for (const path of paths) await compare(path);
  });
  it("retains descending keyset ties and opaque cursors for both history families", async () => {
    for (const [id, time] of [
      [1, 1793491200000],
      [2, 1793491200000],
      [3, 1793577600000],
    ]) {
      await insert("subnet_hyperparams_history", {
        id,
        netuid: id === 2 ? 8 : 7,
        observed_at: time,
        hyperparams_hash: `h${id}`,
        tempo: id,
        registration_allowed: id === 1,
      });
      await insert("account_identity_history", {
        id,
        account: id === 2 ? "other" : "é",
        observed_at: time,
        identity_hash: `h${id}`,
        name: `Identity ${id}`,
      });
    }
    for (const path of paths) await compare(path);
    for (const path of [
      "subnets/7/hyperparameters/history",
      "accounts/%C3%A9/identity-history",
    ]) {
      const first = await compare(`${path}?limit=1`);
      assert.ok(first.next_cursor);
      await compare(
        `${path}?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`,
      );
    }
  });
});
