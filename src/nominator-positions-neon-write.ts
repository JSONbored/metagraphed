// Dispatch nominator positions to their selected D1 or PostgreSQL owner.
// Pruning chunks must contain whole coldkeys. Persist replacements before
// source-scoped pruning, scan coverage and the completeness tally.
// Native Alpha evidence and full self-stake receipts require D1 ownership.

import { selectedD1Store } from "./d1-store.ts";
import { writeNominatorPositionsD1 } from "./ledger-d1.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { normalizeShareFractionsInNeon } from "./neon-write.ts";
import {
  writePassTallyToNeon,
  type PassTallyInput,
} from "./pass-completeness.ts";
import {
  pruneKeysInNeon,
  recordNeonWriteVerdict,
  writeRowsToNeon,
  type NeonWriteResult,
} from "./neon-write.ts";
import { NOMINATOR_POSITION_INSERT_COLUMNS } from "./account-nominator-positions.ts";
import { writeNominatorScanReceipts } from "./nominator-scan-receipts.ts";
import { type HyperdriveLike, type WaitUntilLike } from "./pg-sql.ts";
import {
  neonWriteBufferEnabled,
  neonWriteRunner,
} from "./neon-write-buffer.ts";
import type { LaneHealthDb } from "./lane-health.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";
import type { SelfStakeSnapshot } from "./self-stake-snapshot-d1.ts";

export const NOMINATOR_POSITIONS_NEON_LANE = "nominator-positions";

export const SELF_STAKE_NEON_LANE = "self-stake";

export const POSITION_SOURCE_ALPHA = "alpha";
export const POSITION_SOURCE_SELF_STAKE = "self-stake";

// Source is stamped by the trusted caller, never selected by a wire row.
export const POSITION_INSERT_COLUMNS_WITH_SOURCE = [
  ...NOMINATOR_POSITION_INSERT_COLUMNS,
  "source",
];

// The natural position key excludes source; prune domains remain separate.
export const NOMINATOR_POSITIONS_CONFLICT = [
  "coldkey",
  "hotkey",
  "netuid",
] as const;

type Row = Record<string, unknown>;

export interface NominatorPositionsMirrorOutcome {
  attempted: boolean;
  write?: NeonWriteResult;
  prune?: NeonWriteResult;
  coverage?: NeonWriteResult;
  /** Callers must inspect completeness failures as well as row writes. */
  pass?: NeonWriteResult;
  snapshot?: NeonWriteResult &
    SelfStakeSnapshot & {
      sha256: string;
      received_rows: number;
      received_chunks: number;
      completed_at: number | null;
      complete: boolean;
      positions_retired: number;
      source_rows?: number;
      shadowed_rows?: number;
      alpha_captured_at?: number | null;
    };
}

export interface NominatorPositionsMirrorDeps {
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

export type NominatorPositionsInput = {
  rows: Row[];
  selfStakeSnapshot?: SelfStakeSnapshot;
  coldkeyMaxCapturedAt: ReadonlyMap<string, number>;
  pass?: PassTallyInput | null;
  source?: string;
  lane?: string;
};

/** Return write failures in-band so callers cannot acknowledge lost rows. */
export async function mirrorNominatorPositionsToNeon(
  env: NeonWriteEnv | null | undefined,
  ctx: WaitUntilLike | null | undefined,
  input: NominatorPositionsInput,
  deps: NominatorPositionsMirrorDeps = {},
): Promise<NominatorPositionsMirrorOutcome> {
  const lane = input.lane ?? NOMINATOR_POSITIONS_NEON_LANE;
  const source = input.source ?? POSITION_SOURCE_ALPHA;
  const d1 = selectedD1Store(env, [
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
  ]);
  if (
    input.selfStakeSnapshot &&
    (!d1 || source !== POSITION_SOURCE_SELF_STAKE)
  ) {
    return {
      attempted: true,
      write: {
        ok: false,
        rows: 0,
        statements: 0,
        reason:
          "Full self-stake snapshots require their native D1 source domain",
      },
    };
  }
  if (d1) {
    const outcome = await writeNominatorPositionsD1(d1, input);
    const laneDb = laneHealthStore(env, deps.laneHealthDb);
    const now = deps.now ?? Date.now;
    for (const [key, result] of Object.entries(outcome)) {
      if (key === "attempted" || key === "snapshot") continue;
      const name = key === "write" ? lane : `${lane}-${key}`;
      await recordNeonWriteVerdict(
        laneDb,
        name,
        result as NeonWriteResult,
        now(),
        false,
        key !== "write",
      );
    }
    if (input.pass)
      await recordNeonWriteVerdict(
        laneDb,
        `${NOMINATOR_POSITIONS_NEON_LANE}-normalize`,
        outcome.pass!,
        now(),
        false,
        true,
      );
    return outcome;
  }
  const hyperdrive = env?.HYPERDRIVE as HyperdriveLike | undefined;
  const sql = deps.sql ?? neonWriteRunner(env, ctx, lane, hyperdrive);
  const laneDb = laneHealthStore(env, deps.laneHealthDb);
  // The buffered flush owns successes, but enqueue failures stay visible.
  const buffered = !deps.sql && neonWriteBufferEnabled(env, lane);
  const now = deps.now ?? Date.now;

  if (!sql) {
    const failure = {
      ok: false,
      rows: 0,
      statements: 0,
      reason: "hyperdrive unbound",
    };
    await recordNeonWriteVerdict(laneDb, lane, failure, now(), buffered);
    return { attempted: true, write: failure };
  }

  const write = await writeRowsToNeon(
    sql,
    "nominator_positions",
    POSITION_INSERT_COLUMNS_WITH_SOURCE,
    input.rows.map((row) => ({ ...row, source })),
    NOMINATOR_POSITIONS_CONFLICT,
    // Older PostgreSQL retries cannot replace newer observations.
    "nominator_positions.captured_at < EXCLUDED.captured_at",
  );
  await recordNeonWriteVerdict(laneDb, lane, write, now(), buffered);

  if (!write.ok) return { attempted: true, write };

  const prune = await pruneKeysInNeon(
    sql,
    "nominator_positions",
    "coldkey",
    input.coldkeyMaxCapturedAt,
    source,
  );
  await recordNeonWriteVerdict(
    laneDb,
    `${lane}-prune`,
    prune,
    now(),
    buffered,
    true,
  );

  // Preserve full-scan coverage separately from source-overwritable rows.
  let coverage: NeonWriteResult | undefined;
  if (prune.ok && source === POSITION_SOURCE_ALPHA) {
    coverage = await writeNominatorScanReceipts(sql, input.rows);
    await recordNeonWriteVerdict(
      laneDb,
      `${NOMINATOR_POSITIONS_NEON_LANE}-coverage`,
      coverage,
      now(),
      buffered,
      true,
    );
    if (!coverage.ok) return { attempted: true, write, prune, coverage };
  }

  // Legacy normalization uses raw shares after pruning, before the tally.
  // Failure preserves producer fractions and remains visible in lane health.
  if (prune.ok && input.pass?.capturedAt) {
    const normalized = await normalizeShareFractionsInNeon(
      sql,
      Number(input.pass.capturedAt),
    );
    await recordNeonWriteVerdict(
      laneDb,
      `${NOMINATOR_POSITIONS_NEON_LANE}-normalize`,
      normalized,
      now(),
      buffered,
      true,
    );
  }

  let passResult: NeonWriteResult | undefined;
  if (input.pass) {
    const tally = prune.ok
      ? await writePassTallyToNeon(
          sql,
          NOMINATOR_POSITIONS_NEON_LANE,
          input.pass,
        )
      : { ok: false, reason: "prune did not land; tally withheld" };
    passResult = {
      ok: tally.ok,
      rows: tally.ok ? 1 : 0,
      statements: 1,
      ...(tally.reason ? { reason: tally.reason } : {}),
    };
    await recordNeonWriteVerdict(
      laneDb,
      `${NOMINATOR_POSITIONS_NEON_LANE}-pass`,
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
  return { attempted: true, write, prune, coverage, pass: passResult };
}

/** Prune cutoffs ignore unusable keys and nonfinite capture timestamps. */
export function coldkeyMaxCapturedAt(rows: Row[]): Map<string, number> {
  const cutoffs = new Map<string, number>();
  for (const row of rows) {
    const coldkey = typeof row?.coldkey === "string" ? row.coldkey : null;
    const capturedAt = row?.captured_at;
    if (!coldkey || !Number.isFinite(capturedAt as number)) continue;
    const current = cutoffs.get(coldkey);
    if (current == null || (capturedAt as number) > current) {
      cutoffs.set(coldkey, capturedAt as number);
    }
  }
  return cutoffs;
}
