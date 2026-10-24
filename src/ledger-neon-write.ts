// Dispatch flat ledgers to selected D1 ownership or PostgreSQL compatibility.
// Inline sync and queue callers share this path. Unpruned rows retain their
// last observation; older captured_at retries cannot replace newer values.
// Producer units stay unchanged: balances are TAO, hotkey totals are Alpha.
// Canonical Alpha counts require an anchored native receipt.

import { selectedD1Store } from "./d1-store.ts";
import { alphaCountsNeedAnchor } from "./alpha-counts-d1.ts";
import { writeLedgerD1 } from "./ledger-d1.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import {
  PASS_TABLES,
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
import {
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS } from "./validator-nominator-summary.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";

export const ACCOUNT_BALANCE_INSERT_COLUMNS = [
  "ss58",
  "free_tao",
  "reserved_tao",
  "captured_at",
];

export const HOTKEY_ALPHA_INSERT_COLUMNS = [
  "hotkey",
  "netuid",
  "total_alpha",
  "captured_at",
];

interface LedgerPlan {
  table: string;
  columns: readonly string[];
  conflict: readonly string[];
  filter?: string;
  /** Cast untyped VALUES parameters in filtered PostgreSQL inserts. */
  columnTypes?: Readonly<Record<string, string>>;
}

export const LEDGER_MIRROR_PLANS: Readonly<Record<string, LedgerPlan>> = {
  "account-balances": {
    table: "account_balances",
    columns: ACCOUNT_BALANCE_INSERT_COLUMNS,
    conflict: ["ss58"],
  },
  "hotkey-alpha": {
    table: "hotkey_alpha",
    columns: HOTKEY_ALPHA_INSERT_COLUMNS,
    conflict: ["hotkey", "netuid"],
    // Keep referenced pools; cast src rather than the indexed column.
    filter:
      "EXISTS (SELECT 1 FROM nominator_positions np" +
      " WHERE np.hotkey = src.hotkey AND np.netuid = src.netuid::int)",
    columnTypes: {
      netuid: "int",
      total_alpha: "double precision",
      captured_at: "bigint",
    },
  },
  "validator-nominator-counts": {
    table: "validator_nominator_counts",
    columns: VALIDATOR_NOMINATOR_COUNT_INSERT_COLUMNS,
    conflict: ["hotkey"],
  },
};

export interface LedgerMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/** Persist to the selected owner; callers inspect in-band failures. */
export async function mirrorLedgerToNeon(
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  lane: string,
  rows: Record<string, unknown>[],
  deps: LedgerMirrorDeps = {},
  pass?: PassTallyInput | null,
): Promise<{ attempted: boolean; result?: NeonWriteResult }> {
  const plan = LEDGER_MIRROR_PLANS[lane];
  if (!plan) return { attempted: false };
  if (lane === "validator-nominator-counts") {
    try {
      if (await alphaCountsNeedAnchor(env))
        throw new Error("Canonical Alpha counts require their exact anchor");
    } catch (error) {
      return {
        attempted: true,
        result: { ok: false, rows: 0, statements: 0, reason: String(error) },
      };
    }
  }

  // Row, pass and any joined position tables must share one owner.
  const d1 = selectedD1Store(env, [
    plan.table,
    PASS_TABLES[lane],
    ...(lane === "hotkey-alpha" ? ["nominator_positions"] : []),
  ]);
  if (d1) {
    const result = await writeLedgerD1(d1, lane, rows, pass);
    const laneDb = laneHealthStore(env, deps.laneHealthDb);
    const now = deps.now ?? Date.now;
    await recordNeonWriteVerdict(laneDb, lane, result, now(), false);
    if (pass)
      await recordNeonWriteVerdict(
        laneDb,
        `${lane}-pass`,
        result,
        now(),
        false,
        true,
      );
    return { attempted: true, result };
  }
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql = deps.sql ?? neonWriteRunner(env, ctx, lane, hyperdrive);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  // Buffered success verdicts belong to the flush; failures stay here.
  const buffered = !deps.sql && neonWriteBufferEnabled(env, lane);
  const now = deps.now ?? Date.now;

  if (!sql) {
    await recordNeonWriteVerdict(
      laneDb,
      lane,
      { ok: false, rows: 0, statements: 0, reason: "hyperdrive unbound" },
      now(),
      buffered,
    );
    return { attempted: true };
  }

  const result = await writeRowsToNeon(
    sql,
    plan.table,
    plan.columns,
    rows,
    plan.conflict,
    `${plan.table}.captured_at < EXCLUDED.captured_at`,
    plan.filter,
    plan.columnTypes,
  );
  await recordNeonWriteVerdict(laneDb, lane, result, now(), buffered);

  // PostgreSQL tallies follow successful writes; D1 batches them atomically.
  if (pass && PASS_TABLES[lane]) {
    const tally = result.ok
      ? await writePassTallyToNeon(sql, lane, pass)
      : { ok: false, reason: "rows did not land; tally withheld" };
    await recordNeonWriteVerdict(
      laneDb,
      `${lane}-pass`,
      {
        ok: tally.ok,
        rows: tally.ok ? 1 : 0,
        statements: 1,
        ...(tally.reason ? { reason: tally.reason } : {}),
      },
      now(),
      buffered,
      true,
    );
  }
  return { attempted: true, result };
}
