// The chain-detail lane's Neon mirror (#9787).
//
// Four tables written by one producer pass, so they mirror as one unit and in
// the SAME ORDER the D1 writer uses. That order is load-bearing rather than
// incidental: `chain_detail_blocks` is the COVERAGE REGISTER -- it is what says
// "this block's detail is stored" -- so it goes LAST, after the rows it
// vouches for. Written first, a failure below it would leave the register
// claiming coverage for detail that is not there, and nothing downstream
// re-derives that; it would simply read as a block with no extrinsics.
//
// Same shape as the neurons mirror, and deliberately so -- it runs AFTER the D1
// write returns, never instead of it, and never throws past its own boundary.
// While D1 is still the store the routes read, a Neon failure costs a mirror
// and a lane verdict and nothing else.
import { laneHealthStore } from "./lane-health-store.ts";
import {
  neonDualWriteEnabled,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import {
  CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
  CHAIN_DETAIL_BLOCK_COLUMNS,
  CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
  CHAIN_DETAIL_CONFLICT_KEYS,
  CHAIN_DETAIL_EXTRINSIC_COLUMNS,
} from "./chain-detail-d1-write.ts";
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import type { LaneHealthDb } from "./lane-health.ts";

/** The lane name this mirror answers to in NEON_DUAL_WRITE_LANES. */
export const CHAIN_DETAIL_NEON_LANE = "chain-detail";

type Row = Record<string, unknown>;

interface DetailPlan {
  table: string;
  columns: readonly string[];
  conflict: readonly string[];
  /** Columns that are 0/1 INTEGER in D1 and BOOLEAN in Neon.
   *
   * `success` is the only one, and it is NULLABLE unlike every other boolean in
   * the schema -- an extrinsic whose outcome was not decoded is genuinely
   * unknown, which is a third state that must not collapse to false. */
  booleans?: readonly string[];
}

/**
 * In WRITE ORDER, and the object literal's order is what the loop below
 * follows. blocks last -- see this module's header.
 */
/**
 * Every table this lane writes, for the ownership check (#10107).
 *
 * Derived from the plans below rather than restated: this lane has TWO writers
 * (the HTTP sync and the sync-batches queue consumer), and a hand-kept list
 * would be a third place for them to disagree about which tables move.
 */
export function chainDetailTables(): readonly string[] {
  return CHAIN_DETAIL_MIRROR_PLANS.map((plan) => plan.table);
}

export const CHAIN_DETAIL_MIRROR_PLANS: readonly DetailPlan[] = [
  {
    table: "chain_detail_extrinsics",
    columns: CHAIN_DETAIL_EXTRINSIC_COLUMNS,
    conflict: CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_extrinsics,
    booleans: ["success"],
  },
  {
    table: "chain_detail_chain_events",
    columns: CHAIN_DETAIL_CHAIN_EVENT_COLUMNS,
    conflict: CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_chain_events,
  },
  {
    table: "chain_detail_account_events",
    columns: CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS,
    conflict: CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_account_events,
  },
  {
    table: "chain_detail_blocks",
    columns: CHAIN_DETAIL_BLOCK_COLUMNS,
    conflict: CHAIN_DETAIL_CONFLICT_KEYS.chain_detail_blocks,
  },
];

export interface ChainDetailMirrorInput {
  blockRows: Row[];
  extrinsicRows: Row[];
  chainEventRows: Row[];
  accountEventRows: Row[];
}

export interface ChainDetailMirrorOutcome {
  attempted: boolean;
  results: Record<string, NeonWriteResult>;
}

export interface ChainDetailMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/**
 * D1 stores these flags as 0/1 with a CHECK; Neon's columns are BOOLEAN, and
 * binding a number to one is a type error rather than a coercion.
 *
 * null is PRESERVED. `success` is nullable because an undecoded outcome is
 * unknown, and `Boolean(null)` would publish "it failed" -- a claim the chain
 * never made.
 */
function coerceBooleans(rows: Row[], booleans?: readonly string[]): Row[] {
  if (!booleans?.length || !rows.length) return rows;
  return rows.map((row) => {
    const out: Row = { ...row };
    for (const key of booleans) {
      if (out[key] != null) out[key] = Boolean(out[key]);
    }
    return out;
  });
}

/**
 * Mirror one chain-detail batch into Neon. Never throws.
 *
 * Sequential rather than parallel: the four share one Hyperdrive connection,
 * and the write order is the point.
 */
export async function mirrorChainDetailToNeon(
  env: Record<string, unknown> | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: ChainDetailMirrorInput,
  deps: ChainDetailMirrorDeps = {},
): Promise<ChainDetailMirrorOutcome> {
  if (!neonDualWriteEnabled(env, CHAIN_DETAIL_NEON_LANE)) {
    return { attempted: false, results: {} };
  }

  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString && ctx ? createPgSql(hyperdrive, ctx) : null);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  const now = deps.now ?? Date.now;

  if (!sql) {
    // Enabled but unbound is a MISCONFIGURATION, not a quiet no-op.
    await recordNeonWriteVerdict(
      laneDb,
      CHAIN_DETAIL_NEON_LANE,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
    );
    return { attempted: true, results: {} };
  }

  const byTable: Record<string, Row[]> = {
    chain_detail_extrinsics: input.extrinsicRows,
    chain_detail_chain_events: input.chainEventRows,
    chain_detail_account_events: input.accountEventRows,
    chain_detail_blocks: input.blockRows,
  };

  const results: Record<string, NeonWriteResult> = {};
  for (const plan of CHAIN_DETAIL_MIRROR_PLANS) {
    // THE REGISTER DOES NOT VOUCH FOR ROWS THAT DID NOT LAND. blocks is last,
    // and skipped outright when any detail table failed -- a coverage row over
    // missing detail reads downstream as "this block genuinely had no
    // extrinsics", which is indistinguishable from the truth and never
    // revisited. Withholding it costs nothing: the producer resumes from the
    // head the register reports, so the block is simply re-sent.
    if (
      plan.table === "chain_detail_blocks" &&
      Object.values(results).some((r) => !r.ok)
    ) {
      results[plan.table] = {
        ok: false,
        rows: 0,
        statements: 0,
        reason: "detail did not land; coverage register withheld",
      };
      continue;
    }
    const result = await writeRowsToNeon(
      sql,
      plan.table,
      plan.columns,
      coerceBooleans(byTable[plan.table] ?? [], plan.booleans),
      plan.conflict,
    );
    results[plan.table] = result;
  }

  // One verdict for the batch: these are written by one pass, and a reader
  // wants "did this batch land", not four half-answers.
  const all = Object.values(results);
  const failed = all.filter((r) => !r.ok);
  await recordNeonWriteVerdict(
    laneDb,
    CHAIN_DETAIL_NEON_LANE,
    {
      ok: failed.length === 0,
      rows: all.reduce((n, r) => n + (r.rows ?? 0), 0),
      statements: all.reduce((n, r) => n + (r.statements ?? 0), 0),
      ...(failed.length > 0
        ? { reason: failed.map((r) => r.reason ?? "failed").join("; ") }
        : {}),
    },
    now(),
  );
  return { attempted: true, results };
}

// ---------------------------------------------------------------------------
// Moved here when D1 was deleted (#10170). These describe the TABLE -- its
// column list, its conflict key, its derivations -- not the store that used to
// hold it, and this module is now the only writer.
// ---------------------------------------------------------------------------

export const CHAIN_DETAIL_BLOCK_COLUMNS = [
  "block_number",
  "block_hash",
  "spec_version",
  "extrinsic_count",
  "chain_event_count",
  "account_event_count",
  "observed_at",
  "synced_at",
];

export const CHAIN_DETAIL_EXTRINSIC_COLUMNS = [
  "block_number",
  "extrinsic_index",
  "extrinsic_hash",
  "signer",
  "call_module",
  "call_function",
  "success",
  "fee_tao",
  "tip_tao",
  "call_args",
  "observed_at",
];

export const CHAIN_DETAIL_CHAIN_EVENT_COLUMNS = [
  "block_number",
  "event_index",
  "pallet",
  "method",
  "args",
  "phase",
  "extrinsic_index",
  "observed_at",
];

export const CHAIN_DETAIL_ACCOUNT_EVENT_COLUMNS = [
  "block_number",
  "event_index",
  "extrinsic_index",
  "event_kind",
  "hotkey",
  "coldkey",
  "netuid",
  "uid",
  "amount_tao",
  "alpha_amount",
  "observed_at",
];

export const CHAIN_DETAIL_CONFLICT_KEYS = {
  chain_detail_blocks: ["block_number"],
  chain_detail_extrinsics: ["block_number", "extrinsic_index"],
  chain_detail_chain_events: ["block_number", "event_index"],
  chain_detail_account_events: ["block_number", "event_index"],
} as const;

export const CHAIN_EVENT_PHASES = new Set([
  "ApplyExtrinsic",
  "Finalization",
  "Initialization",
]);
