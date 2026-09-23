import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { Miniflare } from "miniflare";

test("module-filtered recent extrinsics seek an ordered index and preserve tied ordering", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    for (const name of [
      "0014_recent_chain_state.sql",
      "0019_extrinsics_module_index.sql",
    ])
      for (const sql of readFileSync(
        new URL(`../migrations/d1/${name}`, import.meta.url),
        "utf8",
      ).split("-- statement-breakpoint"))
        if (sql.trim()) await db.prepare(sql).run();
    const rows = Array.from({ length: 1200 }, (_, i) => [
      9000000 + Math.floor(i / 3),
      i % 3,
      i % 7 ? "Other" : "Sparse",
      1790000000000 + Math.floor(i / 21),
    ]);
    await db
      .prepare(
        "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,call_module,observed_at) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]') FROM json_each(?)",
      )
      .bind(JSON.stringify(rows))
      .run();
    const sql =
      "SELECT block_number,extrinsic_index FROM chain_detail_extrinsics WHERE call_module=? ORDER BY observed_at DESC,block_number DESC,extrinsic_index DESC LIMIT ?";
    const plan = (
      await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind("Sparse", 25)
        .all<{ detail: string }>()
    ).results
      .map((r) => r.detail)
      .join(" ");
    assert.match(plan, /SEARCH .*idx_chain_detail_extrinsics_module_observed/);
    assert.doesNotMatch(plan, /SCAN|TEMP/);
    const result = (await db.prepare(sql).bind("Sparse", 25).all()).results;
    const expected = rows
      .filter((r) => r[2] === "Sparse")
      .reverse()
      .slice(0, 25)
      .map((r) => ({ block_number: r[0], extrinsic_index: r[1] }));
    assert.deepEqual(result, expected);
    assert.deepEqual(
      (await db.prepare(sql).bind("Absent", 25).all()).results,
      [],
    );
  } finally {
    await runtime.dispose();
  }
});
