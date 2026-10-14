import { z } from "zod";
import { ALPHA_GENESIS, ALPHA_RUNTIMES } from "./alpha-runtime-identity.ts";
import { quoteAlphaPool } from "./alpha-share-value.ts";
import type { OptionalRowReader } from "./read-store.ts";

const safeInteger = z.preprocess(
  (value) =>
    typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value,
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
);
const timestamp = safeInteger.refine(
  (value) => value > 0 && value <= 8_640_000_000_000_000,
);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const AlphaQuantityCaptureSchema = z
  .object({
    captured_at: timestamp,
    block_number: safeInteger.refine((value) => value <= 0xffffffff),
    block_hash: hash,
    genesis_hash: z.literal(ALPHA_GENESIS),
    spec_version: z.union([z.literal(454), z.literal(478)]),
    code_hash: hash,
    metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    expected_rows: safeInteger.refine((value) => value <= 1_000_000),
    received_rows: safeInteger.refine((value) => value <= 1_000_000),
    expected_chunks: safeInteger.refine((value) => value > 0 && value <= 1000),
    received_chunks: safeInteger.refine((value) => value > 0 && value <= 1000),
    completed_at: timestamp,
    selected: z.literal(1),
  })
  .refine(
    (p) =>
      p.expected_rows === p.received_rows &&
      p.expected_chunks === p.received_chunks &&
      p.completed_at >= p.captured_at &&
      p.code_hash === ALPHA_RUNTIMES[p.spec_version].code &&
      p.metadata_sha256 === ALPHA_RUNTIMES[p.spec_version].metadata,
  );
export type AlphaQuantityCapture = z.infer<typeof AlphaQuantityCaptureSchema>;

/** A complete selected pass and its retained metadata owner. Missing old schema,
 * incomplete identity, or a failed read cannot qualify a legacy share fraction.
 * selected records prior promotions cumulatively. Choose the latest canonical
 * owner before joining metadata, so missing metadata cannot borrow an older pass. */
export async function loadAlphaQuantityCapture(
  db: OptionalRowReader | null | undefined,
): Promise<AlphaQuantityCapture | null> {
  if (!db?.first) return null;
  try {
    const parsed = AlphaQuantityCaptureSchema.safeParse(
      await db.first(
        `SELECT p.* FROM (
         SELECT * FROM alpha_snapshot_passes WHERE selected=1 AND completed_at IS NOT NULL
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

export function alphaPositionQuantity(
  row: Record<string, unknown>,
  capture: AlphaQuantityCapture | null,
) {
  const unavailable = {
    alpha_rao: null,
    quantity_status: "unqualified" as const,
    provenance: null,
  };
  const capturedAt = safeInteger.safeParse(row.captured_at);
  if (
    !capture ||
    row.source !== "alpha" ||
    !capturedAt.success ||
    capturedAt.data !== capture.captured_at ||
    !Number.isInteger(row.netuid) ||
    (row.netuid as number) <= 0 ||
    (row.netuid as number) > 65535 ||
    typeof row.alpha_rao !== "string" ||
    typeof row.alpha_evidence !== "string"
  )
    return unavailable;
  try {
    const quote = quoteAlphaPool(
      JSON.parse(row.alpha_evidence),
      capture.spec_version,
    );
    if (quote.alphaRao !== row.alpha_rao) return unavailable;
    return {
      alpha_rao: quote.alphaRao,
      quantity_status: "qualified_snapshot" as const,
      provenance: {
        network: "finney" as const,
        captured_at: new Date(capture.captured_at).toISOString(),
        block_number: capture.block_number,
        block_hash: capture.block_hash,
        genesis_hash: capture.genesis_hash,
        spec_version: capture.spec_version,
        code_hash: capture.code_hash,
        metadata_sha256: capture.metadata_sha256,
      },
    };
  } catch {
    return unavailable;
  }
}
