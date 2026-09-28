import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createD1Store } from "../src/d1-store.ts";
import { readLatestSubnetBurns } from "../src/subnet-burn-read.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  const migration = readFileSync(
    new URL("../migrations/d1/0009_subnet_identity_state.sql", import.meta.url),
    "utf8",
  );
  const ddl = migration
    .split("-- statement-breakpoint")
    .find((sql) => /^CREATE TABLE subnet_burn_history\(/m.test(sql));
  assert(ddl);
  await db.prepare(ddl).run();
  await db
    .prepare(
      `WITH RECURSIVE subnets(n) AS (
    VALUES(0) UNION ALL SELECT n+1 FROM subnets WHERE n<129
  ), ticks(t) AS (VALUES(0) UNION ALL SELECT t+1 FROM ticks WHERE t<19)
  INSERT INTO subnet_burn_history(netuid,observed_at,burn_tao)
  SELECT n,1790000000000+t*900000,
    CASE WHEN n=76 AND t=19 THEN 0 ELSE n+t/1000000000.0 END
  FROM subnets CROSS JOIN ticks
  WHERE n!=8 AND (n!=7 OR t<18)`,
    )
    .run();
});
afterAll(() => runtime.dispose());

test("indexed latest prices match the full history, with bounded reads", async () => {
  const legacy = createD1Store(db);
  const expected = await readLatestSubnetBurns(legacy, {}, []);
  const all = Array.from({ length: 130 }, (_, netuid) => netuid);
  const statements: string[] = [];
  const metrics: { rows_read: number }[] = [];
  const binding = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...values: unknown[]) {
          const statement = db.prepare(sql).bind(...values);
          return {
            async all() {
              const result = await statement.all();
              metrics.push(result.meta);
              return result;
            },
          };
        },
      };
    },
    batch: db.batch.bind(db),
  };
  const env = { D1_STATE: binding, D1_STATE_TABLES: "subnet_burn_history" };
  const portable = {
    query() {
      throw new Error("Native SQL must never reach the portable runner");
    },
  };
  for (const netuids of [all, [0, 7, 7, 76, 999], [8], [999], []]) {
    const actual = await readLatestSubnetBurns(portable, env, netuids);
    assert.deepEqual(
      actual,
      expected.filter((row) => netuids.includes(Number(row.netuid))),
    );
  }
  assert.equal(statements.length, 4, "an empty ranking performs no burn read");
  assert.equal(expected.find((row) => row.netuid === 76)?.burn_tao, 0);
  assert.equal(expected.find((row) => row.netuid === 7)?.burn_tao, 7.000000017);
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
    .bind(JSON.stringify(all))
    .all<{ detail: string }>();
  const details = plan.results.map((row) => row.detail).join("\n");
  assert.match(details, /SEARCH h USING PRIMARY KEY/);
  assert.match(details, /SEARCH latest USING PRIMARY KEY/);
  assert.doesNotMatch(details, /SCAN (?:h|latest)\b/);
  assert(
    metrics[0]!.rows_read <= all.length * 4,
    "cost follows subnet count, not retained history length",
  );
});
