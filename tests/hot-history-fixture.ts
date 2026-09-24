import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";

/** Real SQLite snapshot and schema, shared by the three native reader cases. */
export async function hotHistoryFixture(
  table: "account_events" | "extrinsics" | "chain_events",
  through: number,
  last: number,
  rows: Record<string, unknown>[],
) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
  });
  const db = await runtime.getD1Database("DB");
  for (const sql of readFileSync(
    new URL("../migrations/d1/0014_recent_chain_state.sql", import.meta.url),
    "utf8",
  ).split("-- statement-breakpoint"))
    if (sql.trim()) await db.prepare(sql).run();
  for (let block = through + 1; block <= last; block++)
    await db
      .prepare(
        "INSERT INTO chain_detail_blocks(block_number,block_hash,extrinsic_count,chain_event_count,account_event_count,observed_at,synced_at) VALUES(?,?,0,0,0,1,1)",
      )
      .bind(block, `block-${block}`)
      .run();
  for (const row of rows)
    await db
      .prepare(
        `INSERT INTO chain_detail_${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
          row,
        )
          .map(() => "?")
          .join(",")})`,
      )
      .bind(
        ...Object.entries(row).map(([key, value]) =>
          typeof value === "boolean"
            ? Number(value)
            : typeof value === "number" &&
                ["amount_tao", "alpha_amount", "fee_tao", "tip_tao"].includes(
                  key,
                )
              ? String(value)
              : value,
        ),
      )
      .run();
  return {
    runtime,
    db,
    env: {
      D1_STATE: db,
      D1_STATE_TABLES: `chain_detail_blocks,chain_detail_${table}`,
    },
  };
}
