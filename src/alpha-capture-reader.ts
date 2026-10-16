import { z } from "zod";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
  alphaValuationSpec,
} from "./alpha-runtime-identity.ts";
import { isPostgresReadStore, type OptionalRowReader } from "./read-store.ts";
import { selectedD1Store } from "./d1-store.ts";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const captureSchema = z.object({
  captured_at: integer.positive(),
  block_number: integer.max(0xffffffff),
  block_hash: hash,
  genesis_hash: hash,
  spec_version: integer,
  code_hash: hash,
  metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  expected_rows: integer.max(1_000_000),
  received_rows: integer.max(1_000_000),
  expected_chunks: integer.min(1).max(1000),
  received_chunks: integer.min(1).max(1000),
  completed_at: integer.positive(),
  selected: z.literal(1),
  retained_metadata_sha256: z.string().nullable(),
  retained_code_hash: z.string().nullable(),
  retained_spec_version: integer.nullable(),
});

export interface CanonicalAlphaCapture {
  captured_at: number;
  block_number: number;
  block_hash: string;
  genesis_hash: string;
  spec_version: number;
  code_hash: string;
  metadata_sha256: string;
  quantityQualified: boolean;
}

interface CaptureState {
  available: boolean;
  capture: CanonicalAlphaCapture | null;
}
interface PositionScope {
  column: "coldkey" | "hotkey" | "netuid";
  value: string | number;
}
interface QualificationRow {
  unqualified?: unknown;
}
interface TableRow {
  name?: unknown;
}

/** Exact capture evidence inherits the nominator ledger's D1 owner. */
export const NOMINATOR_POSITIONS_TABLES = [
  "nominator_positions",
  "alpha_runtime_metadata",
  "alpha_snapshot_passes",
  "alpha_snapshot_rows",
] as const;

export const ALPHA_RECEIVER_OWNER_TABLES = [
  "nominator_positions",
  "nominator_positions_passes",
  "nominator_scan_receipts",
  "alpha_runtime_metadata",
  "alpha_snapshot_passes",
  "alpha_snapshot_rows",
] as const;

export function canonicalAlphaOwnerStore(env: unknown) {
  return selectedD1Store(env, ALPHA_RECEIVER_OWNER_TABLES);
}

/** All Alpha tables are installed with their nominator-position owner. */
export async function alphaCaptureStateFromOwner(env: unknown) {
  const store = canonicalAlphaOwnerStore(env);
  if (!store) {
    return { available: false, capture: null };
  }
  return alphaCaptureState(store);
}

/** Self-stake rows have no qualified same-capture originals. Omitting that
 * source, or allowing SUM to drop an unvalued Alpha row, would understate a
 * healthy-looking total. Bound the check to the answer's owner scope. */
export async function alphaPositionsUnqualified(
  db: OptionalRowReader,
  capturedAt: number,
  scope?: PositionScope,
): Promise<boolean> {
  if (
    !db.first ||
    !Number.isSafeInteger(capturedAt) ||
    capturedAt <= 0 ||
    (scope && !["coldkey", "hotkey", "netuid"].includes(scope.column))
  ) {
    throw new TypeError("Invalid Alpha position qualification scope");
  }
  const predicate = scope ? ` AND ${scope.column}=?` : "";
  const values = scope ? [scope.value, capturedAt, scope.value] : [capturedAt];
  const statement = `SELECT
    EXISTS(SELECT 1 FROM nominator_positions WHERE source='self-stake'${predicate})
    OR EXISTS(SELECT 1 FROM alpha_snapshot_rows WHERE captured_at=?
      AND alpha_rao IS NULL${predicate}) AS unqualified`;
  const row = await db.first(statement, values);
  if (!row) {
    return true;
  }
  const qualification = row as QualificationRow;
  return qualification.unqualified !== 0;
}

/** Missing pre-migration schema permits the existing reader during rollout.
 * A failed read throws; it must never be mistaken for absent new schema.
 * Select the newest canonical capture BEFORE metadata or adapter checks:
 * missing evidence or a capture-only runtime cannot borrow an older value. */
export async function alphaCaptureState(
  db: OptionalRowReader | null | undefined,
): Promise<CaptureState> {
  if (!db?.first) {
    throw new TypeError("Alpha capture owner is unavailable");
  }
  if (isPostgresReadStore(db)) {
    return { available: false, capture: null };
  }
  const discovery =
    "SELECT name FROM sqlite_master WHERE type='table' " +
    "AND name='alpha_snapshot_passes'";
  const schema = await db.first(discovery);
  const table = schema as TableRow | null;
  if (!table || table.name !== "alpha_snapshot_passes") {
    return { available: false, capture: null };
  }
  const statement = `SELECT p.*,m.sha256 AS retained_metadata_sha256,
    m.code_hash AS retained_code_hash,m.spec_version AS retained_spec_version
    FROM (SELECT * FROM alpha_snapshot_passes WHERE selected=1
      ORDER BY block_number DESC,captured_at DESC LIMIT 1) p
    LEFT JOIN alpha_runtime_metadata m ON m.sha256=p.metadata_sha256`;
  const selected = await db.first(statement);
  const parsed = captureSchema.safeParse(selected);
  if (!parsed.success) {
    return { available: true, capture: null };
  }
  const p = parsed.data;
  const spec = alphaValuationSpec(p.spec_version);
  const runtime = spec === null ? null : ALPHA_RUNTIMES[spec];
  const quantityQualified = Boolean(
    runtime &&
    p.genesis_hash === ALPHA_GENESIS &&
    p.code_hash === runtime.code &&
    p.metadata_sha256 === runtime.metadata &&
    p.retained_metadata_sha256 === p.metadata_sha256 &&
    p.retained_code_hash === p.code_hash &&
    p.retained_spec_version === p.spec_version &&
    p.expected_rows === p.received_rows &&
    p.expected_chunks === p.received_chunks &&
    p.completed_at >= p.captured_at,
  );
  return {
    available: true,
    capture: {
      captured_at: p.captured_at,
      block_number: p.block_number,
      block_hash: p.block_hash,
      genesis_hash: p.genesis_hash,
      spec_version: p.spec_version,
      code_hash: p.code_hash,
      metadata_sha256: p.metadata_sha256,
      quantityQualified,
    },
  };
}
