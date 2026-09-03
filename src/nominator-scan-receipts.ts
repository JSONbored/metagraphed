// Full-scan delivery evidence must outlive a position's current source (#11997).
// A self-stake refresh can replace an alpha row on the same position key, so
// the mutable ledger cannot also be the record of which coldkeys alpha visited.
import type { NeonWriteResult, PgUnsafe } from "./neon-write.ts";

export const NOMINATOR_SCAN_RECEIPTS_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** One receipt per (capture, coldkey), written after its positions and prune.
 * The producer never splits a coldkey across chunks. Replacing its row count
 * therefore preserves replay idempotence, unlike an additive delivery tally.
 * Counts describe the accepted payload, including duplicate position keys,
 * so their sum can be compared with the producer's declared pass_total. */
export async function writeNominatorScanReceipts(
  sql: PgUnsafe,
  rows: readonly Record<string, unknown>[],
): Promise<NeonWriteResult> {
  if (rows.length === 0) return { ok: true, rows: 0, statements: 0 };
  const receipts = new Map<
    string,
    { captured_at: number; coldkey: string; row_count: number }
  >();
  let oldestCapture = Infinity;
  // These rows already passed the route schema and the ledger's PostgreSQL
  // constraints. Coerce its BIGINT representation without changing the stamp.
  for (const row of rows) {
    const capturedAt = Number(row.captured_at);
    const coldkey = String(row.coldkey);
    oldestCapture = Math.min(oldestCapture, capturedAt);
    const key = JSON.stringify([capturedAt, coldkey]);
    const receipt = receipts.get(key);
    if (receipt) receipt.row_count += 1;
    else receipts.set(key, { captured_at: capturedAt, coldkey, row_count: 1 });
  }
  const captured = [...receipts.values()];
  try {
    await sql.unsafe(
      `WITH expired AS (
         DELETE FROM nominator_scan_receipts WHERE captured_at < $1::bigint
       )
       INSERT INTO nominator_scan_receipts (captured_at, coldkey, row_count)
       SELECT * FROM UNNEST($2::bigint[], $3::text[], $4::int[])
       ON CONFLICT (captured_at, coldkey) DO UPDATE
         SET row_count = EXCLUDED.row_count`,
      [
        oldestCapture - NOMINATOR_SCAN_RECEIPTS_RETENTION_MS,
        captured.map((row) => row.captured_at),
        captured.map((row) => row.coldkey),
        captured.map((row) => row.row_count),
      ],
    );
    return { ok: true, rows: captured.length, statements: 1 };
  } catch (error) {
    return {
      ok: false,
      rows: 0,
      statements: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
