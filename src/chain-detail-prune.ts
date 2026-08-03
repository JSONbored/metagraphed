// Retention for the chain-detail hot tier (#9208).
//
// THE WINDOW ONLY HAS TO COVER ONE GAP: chain tip minus the decoded seam.
// Below the seam the lakehouse holds the same rows, verified, at full depth, so
// a hot row below it is a duplicate that costs D1 space and buys nothing. The
// decode lane runs HOURLY, so that gap is normally <= 2h (~600 blocks at the
// chain's 12s cadence). This is not an archive and it is never backfilled --
// history is the lakehouse's job, and #9208 says so explicitly.
//
// THE FLOOR IS MEASURED, NOT GUESSED (2026-08-03). Ten real blocks were pulled
// from the live API across 8,740,000-8,759,000, loaded into THIS migration's
// exact schema in SQLite, and measured by page count (so index overhead is in
// the number, not left out of it). chain_events args came from the real
// captured fixtures in tests/chain-event-args.test.ts -- block 8,587,754,
// indices 412 and 119 -- because that stream has no live reader to sample:
//
//   extrinsics      1,365 B/row  (mean call_args 863 B), 27.6 rows/block
//   account_events    153 B/row,                        329.8 rows/block
//   chain_events      289 B/row  (mean args 183 B),        339 rows/block
//   -> 181.6 KiB per block
//
// At the chain's ~300 blocks/hour that is ~53 MiB/hour resident, so the 6h
// floor below holds ~319 MiB: 3.1% of D1's 10 GB per-database cap. The 24h
// ceiling holds ~1.25 GiB, 12.5% of the cap, which is the price of the failure
// mode where the decoder has been dead for a full day.
//
// AT SUSTAINED PEAK, which is the number that actually has to fit: the measured
// per-block maxima are 143 extrinsics / 667 chain_events / 461 account_events,
// and a window where EVERY block looks like that costs 448 KiB/block -> 787 MiB
// at 6h (7.7% of the cap) and 3.1 GiB at the 24h ceiling. Still comfortable at
// the floor, and still short of the cap at the ceiling.
//
// ONE HONEST CAVEAT. The 863 B call_args mean was measured on the SERVED
// (normalized) shape, because the raw scale_value tree is only readable through
// the R2 SQL token this repo does not hold. The stored form is the raw tree and
// is therefore LARGER. The peak-case row above absorbs it with room to spare:
// call_args would have to grow ~5x before the 6h window reached a tenth of the
// cap, and the window is 6h -- 3x the hourly decode lane's worst-case lag --
// because that is what #9208 asked for, not because capacity is what bounds it.
//
// THE WINDOW IS ADAPTIVE, and that is the part worth reading. A FIXED 6h window
// would create a gap the moment the decode lane fell more than 6h behind: rows
// dropped here before the lakehouse absorbed them, and every block in between
// declining. So the retained depth follows the SEAM -- the same resolved
// watermark the read path routes on -- and only falls back to the 6h floor when
// the seam is close, which is the normal case. The 24h ceiling is what stops a
// multi-day decoder outage from turning D1 into the archive this tier refuses
// to be; past it the prune resumes and the reads decline, loudly and
// diagnosably, which is the correct failure for a lane that has been broken for
// a day.
//
// PRUNING IS BLOCK-SCOPED, NOT TIME-SCOPED, for the same reason the seam is a
// height: `observed_at` is an observer's clock and the coverage question is
// about heights. A wall-clock cutoff would also make the prune's behaviour
// depend on whether the lane is currently running, which is exactly when it
// must not.

import { resolveBlocksSeam } from "./blocks-cold-tier.ts";

/** ~6h at the chain's 12s cadence: 3x the hourly decode lane's worst-case lag. */
export const CHAIN_DETAIL_MIN_RETAINED_BLOCKS = 1_800;
/** ~24h. The ceiling on how far a stalled decoder can push retention before the
 * prune resumes and the reads start declining. */
export const CHAIN_DETAIL_MAX_RETAINED_BLOCKS = 7_200;
/**
 * Blocks removed per run, at most.
 *
 * The cron fires four times an hour and the chain produces ~300 blocks an hour,
 * so 120 per run keeps up with 1.6x headroom while bounding ONE run's delete to
 * ~150k rows worst case. Unbounded, the first run after a long backlog would
 * try to delete the whole backlog in a single D1 transaction, which is how a
 * maintenance job turns into an outage.
 */
export const CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN = 120;

/**
 * The four tables, with the COVERAGE REGISTER deleted last -- the mirror image
 * of the write path, which writes it last for the same reason.
 *
 * A reader landing mid-prune sees a block still advertised whose rows are
 * already going away, and answers a short list. The other order would have it
 * see rows it is told nothing covers, and DECLINE for a block it could have
 * partially answered. A short answer is recoverable on the next request; a
 * decline for data we still hold is the failure this tier exists to prevent.
 */
const PRUNE_TABLES = [
  "chain_detail_extrinsics",
  "chain_detail_chain_events",
  "chain_detail_account_events",
  "chain_detail_blocks",
];

export interface PruneWindow {
  /** Lowest block the tier should still hold. */
  keepFrom: number;
  /** Retained depth in blocks, after the floor/ceiling clamp. */
  retainedBlocks: number;
}

/**
 * The retention window for one run, from the lane's head and the resolved seam.
 *
 * Pure, so the whole policy is testable without a database: the clamp is the
 * entire rule, and it is one expression rather than a ladder of ifs.
 */
export function chainDetailPruneWindow(input: {
  head: number;
  seam: number;
}): PruneWindow {
  const { head, seam } = input;
  // How far back the lakehouse has NOT reached. One block of overlap at the
  // seam itself is deliberate: a boundary block held by both tiers is served by
  // the cold one and costs a single row, while an off-by-one that held it in
  // neither would decline a block both tiers could answer.
  const uncovered = head - seam;
  const retainedBlocks = Math.min(
    CHAIN_DETAIL_MAX_RETAINED_BLOCKS,
    Math.max(CHAIN_DETAIL_MIN_RETAINED_BLOCKS, uncovered),
  );
  return { keepFrom: head - retainedBlocks + 1, retainedBlocks };
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first?(): Promise<unknown>;
}
interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

function toInt(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

export interface ChainDetailPruneResult {
  ok: boolean;
  reason?: string;
  /** The D1 error text, when the run failed against a bound database. */
  detail?: string;
  /** The window this run computed, absent when nothing could be computed. */
  keep_from?: number;
  retained_blocks?: number;
  /** Exclusive upper bound of the range this run actually deleted. */
  deleted_below?: number;
  /** How many blocks this run removed, capped per run. */
  blocks_pruned?: number;
}

/**
 * One prune tick.
 *
 * Returns a summary rather than throwing, matching the cron family: a tick that
 * cannot run is one missed report, not an outage.
 */
export async function pruneChainDetail(
  env: unknown,
): Promise<ChainDetailPruneResult> {
  const binding = (env as { METAGRAPH_HEALTH_DB?: D1Like } | null | undefined)
    ?.METAGRAPH_HEALTH_DB;
  if (!binding?.prepare || !binding.batch)
    return { ok: false, reason: "d1 binding unavailable" };

  try {
    const bounds = (await binding
      .prepare(
        "SELECT MIN(block_number) AS floor, MAX(block_number) AS head " +
          "FROM chain_detail_blocks",
      )
      .first?.()) as { floor?: unknown; head?: unknown } | null;
    const floor = toInt(bounds?.floor);
    const head = toInt(bounds?.head);
    // An empty tier is not a failure: the lane has simply not written yet.
    if (floor === null || head === null)
      return { ok: true, reason: "no rows", blocks_pruned: 0 };

    const seam = await resolveBlocksSeam(env);
    const window = chainDetailPruneWindow({ head, seam });
    if (window.keepFrom <= floor)
      return {
        ok: true,
        keep_from: window.keepFrom,
        retained_blocks: window.retainedBlocks,
        blocks_pruned: 0,
      };

    // Bounded per run: delete at most CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN
    // blocks upward from the current floor, never the whole backlog at once.
    const deletedBelow = Math.min(
      window.keepFrom,
      floor + CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN,
    );
    await binding.batch(
      PRUNE_TABLES.map((table) =>
        binding
          .prepare(`DELETE FROM ${table} WHERE block_number < ?`)
          .bind(deletedBelow),
      ),
    );
    return {
      ok: true,
      keep_from: window.keepFrom,
      retained_blocks: window.retainedBlocks,
      deleted_below: deletedBelow,
      blocks_pruned: deletedBelow - floor,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "prune_failed",
      ...(err instanceof Error ? { detail: err.message } : {}),
    };
  }
}
