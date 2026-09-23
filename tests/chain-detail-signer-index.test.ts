import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { Miniflare } from "miniflare";

test("signer feed indexing preserves native ordered pages without scanning unrelated transactions", async () => {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  try {
    const db = await runtime.getD1Database("DB");
    const initial = readFileSync(
      new URL("../migrations/d1/0014_recent_chain_state.sql", import.meta.url),
      "utf8",
    );
    for (const sql of initial.split("-- statement-breakpoint"))
      await db.prepare(sql).run();
    for (let i = 0; i < 24; i++)
      await db
        .prepare(
          "INSERT INTO chain_detail_extrinsics(block_number,extrinsic_index,signer,observed_at,call_args) VALUES(?,?,?,?,?)",
        )
        .bind(
          100 + Math.floor(i / 4),
          i % 4,
          i % 3 === 0 ? "account" : i % 3 === 1 ? "other" : null,
          1000 + Math.floor(i / 8),
          JSON.stringify({ ordinal: i }),
        )
        .run();
    const sql =
      "SELECT block_number,extrinsic_index,observed_at,call_args FROM chain_detail_extrinsics WHERE signer = ? ORDER BY observed_at DESC, block_number DESC, extrinsic_index DESC LIMIT ? OFFSET ?";
    const pages = [
      ["account", 3, 0],
      ["account", 3, 2],
      ["missing", 3, 0],
    ] as const;
    const before = await Promise.all(
      pages.map((params) =>
        db
          .prepare(sql)
          .bind(...params)
          .all(),
      ),
    );
    const beforePlan = await db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .bind(...pages[0])
      .all();
    expect(beforePlan.results.map((row) => row.detail).join(" ")).toContain(
      "SCAN chain_detail_extrinsics",
    );
    const migration = readFileSync(
      new URL(
        "../migrations/d1/0023_extrinsic_signer_feed.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.prepare(migration).run();
    await db.prepare(migration).run();
    const after = await Promise.all(
      pages.map((params) =>
        db
          .prepare(sql)
          .bind(...params)
          .all(),
      ),
    );
    expect(after.map((result) => result.results)).toEqual(
      before.map((result) => result.results),
    );
    expect(after[0].results).toHaveLength(3);
    expect(after[1].results).toHaveLength(3);
    expect(after[2].results).toEqual([]);
    const plan = await db
      .prepare("EXPLAIN QUERY PLAN " + sql)
      .bind(...pages[0])
      .all();
    expect(plan.results.map((row) => row.detail)).toEqual([
      "SEARCH chain_detail_extrinsics USING INDEX idx_chain_detail_extrinsics_signer_feed (signer=?)",
    ]);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM chain_detail_extrinsics")
        .first("count"),
    ).toBe(24);
  } finally {
    await runtime.dispose();
  }
});
