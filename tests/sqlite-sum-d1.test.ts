import assert from "node:assert/strict";
import { afterAll, beforeAll, test } from "vitest";
import { Miniflare } from "miniflare";
import { createSqliteSum, sqliteJsonNumber } from "../src/sqlite-sum.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
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

test("native accumulator matches actual D1 JSON SUM, including source numeric kind", async () => {
  for (const values of [
    [],
    [0],
    [1, 2],
    [-1, -2],
    [0.1, 0.2],
    [1e16, 0.1, -1e16],
    [-1e16, 0.1, 1e16],
    [1e20, 1, -1e20],
    [8e18, 8e18, -8e18],
    [-8e18, -8e18, 8e18],
    [8e18, 8e18, 0.1, -8e18],
    [1e18 + 128],
    [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
    [-1e20, -1, 1e20],
    [1, 1e16, 0.1, -1e16],
  ]) {
    const sum = createSqliteSum();
    sum.add(null);
    for (const value of values) sum.add(sqliteJsonNumber(value));
    let expected;
    try {
      expected = await db
        .prepare(
          "SELECT typeof(sum(json_extract(value,'$.n'))) AS kind,quote(sum(json_extract(value,'$.n'))) AS exact,sum(json_extract(value,'$.n')) AS wire FROM json_each(?)",
        )
        .bind(JSON.stringify(values.map((n) => ({ n }))))
        .first<{ kind: string; exact: string; wire: number | null }>();
    } catch (error) {
      assert.match(String(error), /integer overflow/);
      assert.throws(() => sum.value(), /integer overflow/);
      continue;
    }
    const actual = sum.value();
    assert.equal(
      actual?.kind ?? "null",
      expected!.kind,
      JSON.stringify(values),
    );
    if (actual?.kind === "integer")
      assert.equal(
        actual.value.toString(),
        expected!.exact,
        JSON.stringify(values),
      );
    else if (actual?.kind === "real")
      assert.equal(
        Number.isFinite(actual.value) ? actual.value : null,
        expected!.wire,
        JSON.stringify(values),
      );
    else assert.equal(expected!.wire, null, JSON.stringify(values));
  }
  for (const value of [Infinity, -Infinity, NaN])
    assert.throws(() => sqliteJsonNumber(value), /finite/);
});
