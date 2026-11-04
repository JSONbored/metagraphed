import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import worker, { ACCOUNT_STATE_TABLES } from "../workers/data-api.ts";
import { API_KEY_LOOKUP_TOKEN_HEADER } from "../src/api-key-validation.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('fixture'); } };",
  d1Databases: ["DB"],
  compatibilityDate: "2026-06-06",
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
});
afterAll(async () => {
  await runtime.dispose();
});

test("actual D1 numeric bindings are REAL before INTEGER affinity is applied", async () => {
  assert.equal(
    (
      await db
        .prepare("SELECT typeof(?) AS kind")
        .bind(1)
        .first<{ kind: string }>()
    )?.kind,
    "real",
  );
  await db.exec(
    "CREATE TABLE quota_fixture (value INTEGER); INSERT INTO quota_fixture VALUES (9223372036854775807)",
  );
  await db.prepare("UPDATE quota_fixture SET value=value+?").bind(1).run();
  const overflow = await db
    .prepare(
      "SELECT typeof(value) AS kind,printf('%!.17g',value) AS value FROM quota_fixture",
    )
    .first<{ kind: string; value: string }>();
  assert.deepEqual(overflow, { kind: "real", value: "9.2233720368547758e+18" });
  await db.prepare("UPDATE quota_fixture SET value=?").bind(1).run();
  assert.equal(
    (
      await db
        .prepare("SELECT typeof(value) AS kind FROM quota_fixture")
        .first<{ kind: string }>()
    )?.kind,
    "integer",
  );
  const sum = await db
    .prepare("SELECT printf('%!.17g',?+?) AS value")
    .bind(0.1, 0.2)
    .first<{ value: string }>();
  assert.equal(sum?.value, "0.30000000000000004");
});

test("the actual quota composite-key UPSERT applies affinity before conflict arithmetic", async () => {
  await db.exec(
    "CREATE TABLE upsert_fixture (kind TEXT,id INTEGER,day TEXT,value INTEGER,operand_kind TEXT,sum_kind TEXT,PRIMARY KEY(kind,id,day)); INSERT INTO upsert_fixture(kind,id,day,value) VALUES ('rpc',1,'day',9007199254740992)",
  );
  const upsert = db.prepare(
    "INSERT INTO upsert_fixture(kind,id,day,value) VALUES ('rpc',1,'day',?) ON CONFLICT(kind,id,day) DO UPDATE SET value=upsert_fixture.value+excluded.value,operand_kind=typeof(excluded.value),sum_kind=typeof(upsert_fixture.value+excluded.value) WHERE upsert_fixture.value+excluded.value<=? RETURNING value,operand_kind,sum_kind",
  );
  // The exact INTEGER sum exceeds the REAL limit, even though its JSON
  // representation would round down to the limit.
  assert.deepEqual((await upsert.bind(1, 9007199254740992).all()).results, []);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(value) AS kind,quote(value) AS value FROM upsert_fixture",
      )
      .first(),
    { kind: "integer", value: "9007199254740992" },
  );
  assert.deepEqual((await upsert.bind(1, 9007199254740994).all()).results, [
    { value: 9007199254740992, operand_kind: "integer", sum_kind: "integer" },
  ]);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(value) AS kind,quote(value) AS value FROM upsert_fixture",
      )
      .first(),
    { kind: "integer", value: "9007199254740993" },
  );
  await upsert.bind(1, 9007199254740994).run();
  assert.equal(
    (
      await db
        .prepare("SELECT quote(value) AS value FROM upsert_fixture")
        .first<{ value: string }>()
    )?.value,
    "9007199254740994",
  );
  await db.exec("UPDATE upsert_fixture SET value=9223372036854775807");
  const overflow = (await upsert.bind(1, 1e20).all()).results[0];
  assert.deepEqual(overflow, {
    value: 2 ** 63,
    operand_kind: "integer",
    sum_kind: "real",
  });
});

test("the actual quota HTTP handler retains those binding and fractional semantics", async () => {
  await db.exec(
    "CREATE TABLE api_quota_daily(account_kind TEXT,account_id INTEGER,day TEXT,units_spent INTEGER,updated_at INTEGER,PRIMARY KEY(account_kind,account_id,day))",
  );
  const token = "fixture-internal";
  const env = {
    D1_STATE: db,
    D1_STATE_TABLES: ACCOUNT_STATE_TABLES.join(","),
    API_KEY_LOOKUP_INTERNAL_TOKEN: token,
  } as unknown as DataApiEnv;
  const ctx = { waitUntil() {} } as unknown as ExecutionContext;
  const spend = (account_id: number, cost: number, limit: number) =>
    worker.fetch(
      new Request("https://data.example.com/api/v1/internal/keys/quota", {
        method: "POST",
        headers: {
          [API_KEY_LOOKUP_TOKEN_HEADER]: token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ account_id, cost, limit }),
      }),
      env,
      ctx,
    );
  const day = new Date().toISOString().slice(0, 10);
  await db
    .prepare(
      "INSERT INTO api_quota_daily VALUES ('rpc',1,?,9007199254740992,0)",
    )
    .bind(day)
    .run();
  const large = await spend(1, 1, 9007199254740992);
  assert.equal(large.status, 200);
  assert.equal(((await large.json()) as { allowed: boolean }).allowed, true);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT quote(units_spent) AS value FROM api_quota_daily WHERE account_id=1",
        )
        .first<{ value: string }>()
    )?.value,
    "9007199254740992",
  );
  await spend(1, 1, 9007199254740994);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT quote(units_spent) AS value FROM api_quota_daily WHERE account_id=1",
        )
        .first<{ value: string }>()
    )?.value,
    "9007199254740993",
  );
  await spend(2, 0.1, 0.3);
  const fraction = await spend(2, 0.2, 0.3);
  const body = (await fraction.json()) as { allowed: boolean; used: number };
  assert.equal(body.allowed, false);
  assert.equal(body.used, 0.1);
  await spend(1e30, 1, 10);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT typeof(account_id) AS kind FROM api_quota_daily WHERE account_id=?",
        )
        .bind(1e30)
        .first<{ kind: string }>()
    )?.kind,
    "real",
  );
});
