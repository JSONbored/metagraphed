import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  d1Databases: ["DB"],
  compatibilityDate: "2026-06-06",
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const objects = JSON.parse(
    readFileSync(
      new URL("../generated/db/d1-schema.json", import.meta.url),
      "utf8",
    ),
  ) as { type: string; name: string; sql: string }[];
  for (const object of objects.filter(
    (entry) =>
      entry.type === "table" &&
      [
        "github_accounts",
        "api_key_blocks",
        "api_key_usage_daily",
        "api_usage_rollup",
      ].includes(entry.name),
  ))
    await db.prepare(object.sql).run();
});
afterAll(async () => {
  await runtime.dispose();
});

test("actual D1 source columns retain wide identifiers and fractional usage account IDs", async () => {
  await db
    .prepare(
      "INSERT INTO github_accounts(github_user_id,github_login,created_at) VALUES (?,'fixture',0)",
    )
    .bind(1e30)
    .run();
  await db
    .prepare(
      "INSERT INTO api_key_blocks(account_id,reason_code,blocked_at) VALUES (?,'abuse_manual',0)",
    )
    .bind(1e30)
    .run();
  await db
    .prepare(
      "INSERT INTO api_key_usage_daily(account_id,day,route) VALUES (?,'day','route')",
    )
    .bind(0.1)
    .run();
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(github_user_id) AS kind,github_user_id AS value FROM github_accounts",
      )
      .first(),
    { kind: "real", value: 1e30 },
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(account_id) AS kind,account_id AS value FROM api_key_blocks",
      )
      .first(),
    { kind: "real", value: 1e30 },
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(account_id) AS kind,account_id AS value FROM api_key_usage_daily",
      )
      .first(),
    { kind: "real", value: 0.1 },
  );
});

test("actual D1 usage counters promote integer overflow and retain REAL aggregate infinity", async () => {
  await db.exec(
    "INSERT INTO api_key_usage_daily(account_id,day,route,request_count,rejected_count) VALUES (2,'day','route',9223372036854775807,9223372036854775807)",
  );
  await db.exec(
    "UPDATE api_key_usage_daily SET request_count=request_count+1,rejected_count=rejected_count+1 WHERE account_id=2",
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(request_count) AS requests,typeof(rejected_count) AS rejected FROM api_key_usage_daily WHERE account_id=2",
      )
      .first(),
    { requests: "real", rejected: "real" },
  );
  await db
    .prepare(
      "INSERT INTO api_usage_rollup SELECT 'day','route','edge',sum(json_extract(value,'$')),sum(json_extract(value,'$')) FROM json_each(?)",
    )
    .bind(JSON.stringify([Number.MAX_VALUE, Number.MAX_VALUE]))
    .run();
  assert.deepEqual(
    await db
      .prepare(
        "SELECT typeof(request_count) AS requests,quote(request_count) AS value,typeof(keyed_count) AS keyed FROM api_usage_rollup",
      )
      .first(),
    { requests: "real", value: "9.0e+999", keyed: "real" },
  );
});
