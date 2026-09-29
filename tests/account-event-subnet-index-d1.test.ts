import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";

const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('test')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["DB"],
});
let db: D1Database;
beforeAll(async () => {
  db = await runtime.getD1Database("DB");
  for (const file of [
    "0014_recent_chain_state.sql",
    "0033_account_event_subnet_tail_index.sql",
  ])
    for (const sql of readFileSync(
      new URL(`../migrations/d1/${file}`, import.meta.url),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
});
afterAll(async () => runtime.dispose());

it("seeks selected subnets and block bounds without reading other subnet events", async () => {
  await db
    .prepare(
      `WITH RECURSIVE items(n) AS
    (SELECT 0 UNION ALL SELECT n+1 FROM items WHERE n<10000)
    INSERT INTO chain_detail_account_events(block_number,event_index,event_kind,netuid,observed_at)
    SELECT 12,n,'StakeAdded',99,12000 FROM items`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO chain_detail_account_events
    (block_number,event_index,event_kind,netuid,observed_at) VALUES
    (1,0,'StakeAdded',64,14000),(11,0,'StakeAdded',64,11000),
    (12,10001,'StakeRemoved',65,12000),(13,0,'StakeAdded',64,13000)`,
    )
    .run();
  const sql = `SELECT block_number,event_index,event_kind,netuid,observed_at
    FROM chain_detail_account_events INDEXED BY idx_chain_detail_account_events_netuid_block
    WHERE netuid IN (?,?) AND block_number>? AND block_number<=?
      AND ((netuid=? AND event_kind=?) OR (netuid=? AND event_kind=?))
    ORDER BY observed_at DESC,block_number DESC,event_index DESC LIMIT ?`;
  const values = [64, 65, 10, 13, 64, "StakeAdded", 65, "StakeRemoved", 4];
  const result = await db
    .prepare(sql)
    .bind(...values)
    .all();
  const reference = await db
    .prepare(
      sql.replace(
        "idx_chain_detail_account_events_netuid_block",
        "sqlite_autoindex_chain_detail_account_events_1",
      ),
    )
    .bind(...values)
    .all();
  expect(result.results).toEqual(reference.results);
  expect(result.results.map((row) => row.block_number)).toEqual([13, 12, 11]);
  expect(result.meta.rows_read).toBeLessThan(100);
  expect(reference.meta.rows_read).toBeGreaterThan(10000);
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...values)
    .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join("\n")).toContain(
    "idx_chain_detail_account_events_netuid_block (netuid=? AND block_number>? AND block_number<?)",
  );
});
