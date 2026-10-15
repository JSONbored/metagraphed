import { z } from "zod";
import { ALPHA_GENESIS, ALPHA_RUNTIMES } from "./alpha-runtime-identity.ts";
import { quoteAlphaPool } from "./alpha-share-value.ts";

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
export const AlphaCompleteCaptureSchema = z
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
    selected: z.union([z.literal(0), z.literal(1)]),
  })
  .refine(
    (p) =>
      p.expected_rows === p.received_rows &&
      p.expected_chunks === p.received_chunks &&
      p.completed_at >= p.captured_at &&
      p.code_hash === ALPHA_RUNTIMES[p.spec_version].code &&
      p.metadata_sha256 === ALPHA_RUNTIMES[p.spec_version].metadata,
  );
export type AlphaCompleteCapture = z.infer<typeof AlphaCompleteCaptureSchema>;
export const AlphaQuantityCaptureSchema = AlphaCompleteCaptureSchema.refine(
  (p) => p.selected === 1,
);
export type AlphaQuantityCapture = z.infer<typeof AlphaQuantityCaptureSchema>;

export function alphaQuantityProvenance(capture: AlphaCompleteCapture) {
  return {
    network: "finney" as const,
    captured_at: new Date(capture.captured_at).toISOString(),
    block_number: capture.block_number,
    block_hash: capture.block_hash,
    genesis_hash: capture.genesis_hash,
    spec_version: capture.spec_version,
    code_hash: capture.code_hash,
    metadata_sha256: capture.metadata_sha256,
  };
}

export function alphaPositionQuantity(
  row: Record<string, unknown>,
  capture: AlphaCompleteCapture | null,
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
      provenance: alphaQuantityProvenance(capture),
    };
  } catch {
    return unavailable;
  }
}
