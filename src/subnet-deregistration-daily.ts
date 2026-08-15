// A daily row per subnet of what the deregistration ranking is computed FROM
// (#10296), so a trajectory exists rather than only today's answer.
//
// ## It stores the INPUTS, and that is the whole design
//
// `src/subnet-deregistration-ranking.ts` splits its fields two ways: four are
// MEASURED (`SubnetMovingPrice`, `NetworkRegisteredAt`, `SubnetMechanism`,
// `NetworkImmunityPeriod`) and everything a caller reads off the card -- `rank`,
// `comparison_price`, `immune`, `blocks_until_prunable` -- is declared
// `kind: "reconstructed", storage: null`. Those are produced by a RULE, and
// #10285 exists because the rule is subtle: a price-only order names netuid 86
// first where the chain names 70, because immunity and the Stable-mechanism
// substitution both bite.
//
// Persisting `rank` would freeze one version of that rule into history, and a
// later correction could not reach the old rows. Persisting the inputs means
// the same fix corrects every past day, and `projectDeregistrationRanking`
// replays them unchanged. See migrations/neon/0015 for the fuller argument.
//
// ## No new chain reads
//
// The economics sweep already captures all four and pins them to one block --
// the live route computes from exactly this blob per request. This lane reads
// the same thing once a day and appends; there is no producer change.
//
// ## Why the writes are guarded rather than trusted
//
// A lane that appends whatever it read will happily write a day of nulls when
// the blob is missing or half-built, and a null day is indistinguishable from a
// subnet that genuinely had no price. Both guards below exist for that: the
// blob must project at all, and it must cover a plausible number of subnets.

import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { createPgSql } from "./pg-sql.ts";
import { projectDeregistrationRanking } from "./subnet-deregistration-ranking.ts";
import type { NeonWriteEnv } from "./neon-write-buffer.ts";

interface WaitUntilLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

export const SUBNET_DEREGISTRATION_DAILY_LANE = "subnet-deregistration-daily";

export const SUBNET_DEREGISTRATION_DAILY_TABLE = "subnet_deregistration_daily";

/**
 * Fewest subnets a pass may cover before it is treated as partial.
 *
 * The same shape as the lifecycle lane's floor and for the same reason: a short
 * read is not a small day. Mainnet has run 128-129 subnets for months, so 100
 * is comfortably below any real field while still catching a blob that was
 * half-built -- which is the failure that would otherwise write a day of rows
 * for a third of the network and look like a successful tick.
 */
export const DEREGISTRATION_DAILY_COVERAGE_FLOOR = 100;

/** One subnet's measured inputs on one day. */
export interface DeregistrationDailyRow {
  netuid: number;
  snapshot_date: string;
  moving_price: number | null;
  registered_at_block: number | null;
  subnet_mechanism: number | null;
  network_immunity_period: number | null;
  pinned_block: number | null;
  captured_at: number;
}

interface EconomicsBlob {
  chain_state?: {
    block?: unknown;
    network_immunity_period?: unknown;
  } | null;
  subnets?: unknown;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The rows one economics blob yields, or `null` when it cannot be trusted.
 *
 * PURE, so the extraction is testable without a store, a clock or a network --
 * which matters more than usual here because every field is nullable and a
 * silent all-null day is exactly the failure mode.
 *
 * Returns null rather than [] when the blob does not project: `[]` would be
 * written as "a day with no subnets", and the caller must be able to tell that
 * from "we could not read".
 */
export function deregistrationDailyRows(
  economics: unknown,
  snapshotDate: string,
  capturedAt: number,
): DeregistrationDailyRow[] | null {
  // Gate on the PROJECTOR, not on the raw blob. It is the thing that decides
  // whether these inputs are usable at all -- it returns null when the block or
  // the immunity period is missing, and a ranking cannot be replayed without
  // either. Re-deriving that judgement here would be a second opinion that can
  // drift from the one the route uses.
  if (!projectDeregistrationRanking(economics)) return null;

  const blob = (economics ?? {}) as EconomicsBlob;
  const chainState = blob.chain_state ?? {};
  const pinnedBlock = numberOrNull(chainState.block);
  const immunityPeriod = numberOrNull(chainState.network_immunity_period);
  const rows = Array.isArray(blob.subnets) ? blob.subnets : [];

  const out: DeregistrationDailyRow[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (!Number.isInteger(row?.netuid)) continue;
    out.push({
      netuid: row.netuid as number,
      snapshot_date: snapshotDate,
      // `moving_price_pinned` is the blob's name for SubnetMovingPrice read at
      // the pinned block -- the same field projectDeregistrationRanking reads,
      // named the same way on purpose so the two cannot diverge.
      moving_price: numberOrNull(row.moving_price_pinned),
      registered_at_block: numberOrNull(row.registered_at_block),
      subnet_mechanism: numberOrNull(row.subnet_mechanism),
      network_immunity_period: immunityPeriod,
      pinned_block: pinnedBlock,
      captured_at: capturedAt,
    });
  }
  return out;
}

/**
 * The upsert.
 *
 * ON CONFLICT rather than a plain append because the lane may tick more than
 * once a day, and a second tick on the same date is a re-observation of that
 * day -- not a second day and not an error.
 *
 * THE GUARD IS THE POINT. The update only applies when the incoming row is at a
 * block at least as new as the stored one, so a late tick reading an older
 * pinned blob cannot overwrite a fresher observation with a staler one. That is
 * the same out-of-order protection the other Neon write paths carry, and it is
 * why `pinned_block` is compared rather than `captured_at`: the wall clock says
 * when we looked, the block says what we saw.
 *
 * `COALESCE(existing, -1)` so a stored NULL block always loses to a real one.
 */
export const DEREGISTRATION_DAILY_UPSERT_TAIL =
  " ON CONFLICT (netuid, snapshot_date) DO UPDATE SET " +
  "moving_price = EXCLUDED.moving_price, " +
  "registered_at_block = EXCLUDED.registered_at_block, " +
  "subnet_mechanism = EXCLUDED.subnet_mechanism, " +
  "network_immunity_period = EXCLUDED.network_immunity_period, " +
  "pinned_block = EXCLUDED.pinned_block, " +
  "captured_at = EXCLUDED.captured_at " +
  `WHERE COALESCE(EXCLUDED.pinned_block, -1) >= COALESCE(${SUBNET_DEREGISTRATION_DAILY_TABLE}.pinned_block, -1)`;

const COLUMNS = [
  "netuid",
  "snapshot_date",
  "moving_price",
  "registered_at_block",
  "subnet_mechanism",
  "network_immunity_period",
  "pinned_block",
  "captured_at",
] as const;

/** `INSERT … VALUES ($1,…), ($9,…) … ON CONFLICT …` for `rowCount` rows. */
export function deregistrationDailyUpsertSql(rowCount: number): string {
  const groups: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const params = COLUMNS.map(
      (_, col) => `$${row * COLUMNS.length + col + 1}`,
    );
    groups.push(`(${params.join(", ")})`);
  }
  return (
    `INSERT INTO ${SUBNET_DEREGISTRATION_DAILY_TABLE} (${COLUMNS.join(", ")}) ` +
    `VALUES ${groups.join(", ")}${DEREGISTRATION_DAILY_UPSERT_TAIL}`
  );
}

/** Row objects flattened to one positional bind list, in COLUMNS order. */
export function deregistrationDailyBinds(
  rows: readonly DeregistrationDailyRow[],
): unknown[] {
  return rows.flatMap((row) => COLUMNS.map((column) => row[column]));
}

export interface DeregistrationDailyDeps {
  /** The economics blob this tick should record. */
  readEconomics: () => Promise<unknown>;
  sql?: {
    unsafe(text: string, values?: unknown[]): Promise<unknown>;
  } | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
  coverageFloor?: number;
  ctx?: WaitUntilLike | null;
}

/** `YYYY-MM-DD` in UTC, the key subnet_snapshots uses. */
export function snapshotDateFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * One tick. Returns a summary rather than throwing, like the rest of the lane
 * family -- a capture lane that can take down the cron it shares would be worse
 * than a gap in the series.
 */
export async function runSubnetDeregistrationDailyLane(
  env: NeonWriteEnv | null | undefined,
  deps: DeregistrationDailyDeps,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now;
  const floor = deps.coverageFloor ?? DEREGISTRATION_DAILY_COVERAGE_FLOOR;
  const capturedAt = now();

  const record = async (
    verdict: "ok" | "stale",
    detail: string,
  ): Promise<void> => {
    await recordLaneVerdict(laneHealthStore(env, deps.laneHealthDb), {
      lane: SUBNET_DEREGISTRATION_DAILY_LANE,
      verdict,
      age_ms: null,
      detail,
      checked_at: capturedAt,
    });
  };

  // Same derivation as the lifecycle lane: readStore hands back a READ handle
  // with no run()/unsafe(), so an append needs its own runner. The bare
  // `waitUntil: () => {}` covers callers with no ExecutionContext -- calling
  // ctx.waitUntil on a `{}` throws, and taking the lane down over connection
  // bookkeeping would be worse than the connection outliving the tick.
  const hyperdrive = env?.HYPERDRIVE as
    { connectionString: string } | undefined;
  const sql =
    deps.sql ??
    (hyperdrive?.connectionString
      ? createPgSql(hyperdrive, deps.ctx ?? { waitUntil: () => {} })
      : null);
  if (!sql?.unsafe) {
    await record("stale", "no store bound");
    return { ok: false, reason: "no_store_bound" };
  }

  try {
    const rows = deregistrationDailyRows(
      await deps.readEconomics(),
      snapshotDateFor(capturedAt),
      capturedAt,
    );
    if (rows === null) {
      // The blob did not project. NOT an empty day -- writing nothing and
      // reporting ok would let a broken economics sweep read as a quiet one.
      await record("stale", "economics blob did not project a ranking");
      return { ok: false, reason: "economics_unavailable" };
    }
    if (rows.length < floor) {
      await record(
        "stale",
        `partial: ${rows.length} subnet(s) under the ${floor} floor -- nothing written`,
      );
      return { ok: false, reason: "partial_coverage", captured: rows.length };
    }

    await sql.unsafe(
      deregistrationDailyUpsertSql(rows.length),
      deregistrationDailyBinds(rows),
    );
    const block = rows[0]?.pinned_block ?? null;
    await record(
      "ok",
      `captured ${rows.length} subnet(s) at block ${block ?? "unknown"}`,
    );
    return {
      ok: true,
      captured: rows.length,
      snapshot_date: rows[0]?.snapshot_date ?? null,
      pinned_block: block,
    };
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    await record("stale", `write failed: ${reason}`);
    return { ok: false, reason: "write_failed", detail: reason };
  }
}
