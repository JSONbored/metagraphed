import {
  alphaCaptureState,
  alphaPositionsUnqualified,
} from "./alpha-capture-reader.ts";
import type { OptionalRowQuerier, OptionalRowReader } from "./read-store.ts";

type Row = Record<string, unknown>;

/** The L3 split must follow the same canonical evidence as holdings readers.
 * Unpriced self-stake and a failed/racing read decline the split, preserving
 * the owner card's independent emission history. */
export async function ownerCapturePositions(
  db: (OptionalRowReader & OptionalRowQuerier) | null,
  netuid: number,
  legacy: () => Promise<Row[]>,
): Promise<Row[]> {
  if (!db) return legacy();
  try {
    const state = await alphaCaptureState(db);
    if (!state.available) return legacy();
    const capture = state.capture;
    if (!capture?.quantityQualified || !db.query || !db.first) return [];
    const capturedAt = capture.captured_at;
    const scope = { column: "netuid" as const, value: netuid };
    if (await alphaPositionsUnqualified(db, capturedAt, scope)) return [];
    const rows = await db.query<Row>(
      "SELECT coldkey,hotkey,share_fraction FROM alpha_snapshot_rows WHERE netuid=? AND captured_at=?",
      [netuid, capturedAt],
    );
    const unqualified = await alphaPositionsUnqualified(db, capturedAt, scope);
    const after = await alphaCaptureState(db);
    if (
      unqualified ||
      !after.capture?.quantityQualified ||
      after.capture.captured_at !== capture.captured_at ||
      after.capture.block_hash !== capture.block_hash ||
      rows.some(
        (row) =>
          typeof row.share_fraction !== "number" ||
          !Number.isFinite(row.share_fraction) ||
          row.share_fraction < 0 ||
          row.share_fraction > 1,
      )
    )
      return [];
    return rows;
  } catch {
    return [];
  }
}
