import { readStore, type OptionalRowReader } from "./read-store.ts";
import { ALPHA_QUANTITY_TABLES } from "./read-store-tables.ts";
import {
  AlphaQuantityCaptureSchema,
  type AlphaQuantityCapture,
} from "./alpha-quantity-capture.ts";
export {
  AlphaQuantityCaptureSchema,
  alphaQuantityProvenance,
  alphaPositionQuantity,
  type AlphaQuantityCapture,
} from "./alpha-quantity-capture.ts";

/** Resolve the complete family under one owner; partial rollout fails closed. */
export function alphaQuantityStore(env: unknown) {
  try {
    return readStore(env, ALPHA_QUANTITY_TABLES);
  } catch {
    return undefined;
  }
}

export async function loadAlphaQuantityCaptureFromOwner(env: unknown) {
  return loadAlphaQuantityCapture(alphaQuantityStore(env));
}

/** Select the latest canonical owner before joining metadata. A missing original
 * cannot borrow an older pass; incomplete or legacy shares stay unqualified. */
export async function loadAlphaQuantityCapture(
  db: OptionalRowReader | null | undefined,
): Promise<AlphaQuantityCapture | null> {
  if (!db?.first) return null;
  try {
    const parsed = AlphaQuantityCaptureSchema.safeParse(
      await db.first(
        `SELECT p.* FROM (
         SELECT * FROM alpha_snapshot_passes WHERE selected=1
         ORDER BY block_number DESC,captured_at DESC LIMIT 1
       ) p JOIN alpha_runtime_metadata m
       ON m.sha256=p.metadata_sha256 AND m.code_hash=p.code_hash AND m.spec_version=p.spec_version`,
      ),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
