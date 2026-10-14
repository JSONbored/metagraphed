import { readFileSync } from "node:fs";
import {
  syntheticAlphaCapture,
  syntheticAlphaPosition,
} from "./alpha-quantity-fixture.ts";

/** Real D1 schema, with synthetic read fixtures rather than native writer claims. */
export async function installAlphaQuantityD1Schema(db: D1Database) {
  for (const file of [
    "0010_ledger_state.sql",
    "0039_self_stake_snapshot_receipts.sql",
    "0042_alpha_runtime_snapshots.sql",
  ]) {
    const sql = readFileSync(
      new URL(`../../migrations/d1/${file}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql.split("-- statement-breakpoint"))
      if (statement.trim()) await db.prepare(statement).run();
  }
}

export async function seedAlphaQuantityD1Pass(
  db: D1Database,
  capturedAt: number,
  rows: ReturnType<typeof syntheticAlphaPosition>[],
  spec: 454 | 478 = 454,
) {
  const capture = syntheticAlphaCapture(capturedAt, {
    spec_version: spec,
    expected_rows: rows.length,
    received_rows: rows.length,
  });
  const runtime = JSON.parse(
    readFileSync(
      new URL(`../fixtures/alpha-runtime/frozen-${spec}.json`, import.meta.url),
      "utf8",
    ),
  ).alpha_snapshot;
  await db
    .prepare(
      "INSERT OR IGNORE INTO alpha_runtime_metadata (sha256,code_hash,spec_version,scale_hex) VALUES(?,?,?,?)",
    )
    .bind(
      capture.metadata_sha256,
      capture.code_hash,
      spec,
      runtime.metadata_scale_hex,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO alpha_snapshot_passes
       (captured_at,block_number,block_hash,genesis_hash,spec_version,code_hash,metadata_sha256,
        scanned_legacy,scanned_v2,expected_rows,received_rows,expected_chunks,received_chunks,completed_at,selected)
       VALUES(?,?,?,?,?,?,?,?,0,?,?,1,1,?,1)`,
    )
    .bind(
      capture.captured_at,
      capture.block_number,
      capture.block_hash,
      capture.genesis_hash,
      spec,
      capture.code_hash,
      capture.metadata_sha256,
      rows.length,
      rows.length,
      rows.length,
      capture.completed_at,
    )
    .run();
  for (const row of rows)
    await db
      .prepare(
        `INSERT INTO nominator_positions
         (coldkey,hotkey,netuid,source,captured_at,share_fraction,shares,alpha_rao,alpha_evidence)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        row.coldkey,
        row.hotkey,
        row.netuid,
        row.source,
        row.captured_at,
        row.share_fraction,
        row.shares,
        row.alpha_rao,
        row.alpha_evidence,
      )
      .run();
  return capture;
}
