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
// floor below holds ~319 MiB: 3.1% of the store's 10 GB per-database cap. The 24h
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
import {
  createPgSql,
  type HyperdriveLike,
  type WaitUntilLike,
} from "./pg-sql.ts";
import { readStore, type ReadStoreDb, safeIntOrNull } from "./read-store.ts";
import { CHAIN_DETAIL_HOT_TIER_TABLES } from "./chain-detail-hot-tier.ts";

/** ~6h at the chain's 12s cadence: 3x the hourly decode lane's worst-case lag. */
export const CHAIN_DETAIL_MIN_RETAINED_BLOCKS = 1_800;
/** ~24h. The ceiling on how far a stalled decoder can push retention before the
 * prune resumes and the reads start declining. */
export const CHAIN_DETAIL_MAX_RETAINED_BLOCKS = 7_200;

/**
 * `chain_detail_account_events` keeps ~30h, and it is the ONE table that does.
 *
 * ## Why this table answers a second question
 *
 * Every other table here exists to cover one gap: chain tip minus the decoded
 * seam, which an hourly decode lane holds to ~2h. This one is also the hot tier
 * for the ACCOUNT family, and that family asks something different -- "does this
 * store reach back past the projection's fold edge", the overlap
 * `loadAccountEventsAboveFloorHotTier` checks before it serves.
 *
 * The two questions have different answers because the fold edge moves in DAY
 * steps. `through` is the last COMPLETE day the producer folded, so the edge sits
 * up to 24h behind, plus the lane's hourly cadence -- ~25h at worst in normal
 * operation. A 6h floor cannot reach it, ever.
 *
 * MEASURED, not assumed. Live on 2026-08-17 the overlap was BROKEN by 6.8h:
 * `through` 2026-08-15 put the fold edge at 2026-08-16T00:00Z against a hot
 * floor of 06:51Z. The fast path was correct, safe, and never taken -- it had
 * held exactly once, right after the projection recovered with an unusual
 * `through`, which is a lucky sample rather than the steady state.
 *
 * ## Why only this table, and what it costs
 *
 * Measured live the same day: `chain_detail_account_events` plus its index is
 * 324 MiB over 5,175 blocks -- 64.1 KiB/block, a quarter of the four tables'
 * combined weight. Deepening it alone to 9,000 blocks costs ~451 MiB over the
 * 6h floor, and leaves `chain_events` (410 MiB) and `extrinsics` (220 MiB) --
 * the actual bulk -- exactly where they are. Deepening all four would have cost
 * roughly four times as much to fix one family's reads.
 *
 * ## Why 30h and not more
 *
 * ~5h of margin over the ~25h worst case, which absorbs a missed producer pass.
 * It does NOT absorb an outage -- the lane was dark for 33h on 2026-08-16 -- and
 * it deliberately does not try: past this, the overlap check fails and the
 * account routes fall back to the bounded lakehouse read, correct and slower,
 * while the container-lane watchdog pages within 6h. Sizing retention for an
 * outage is how a hot tier becomes the archive this one refuses to be.
 */
export const ACCOUNT_EVENTS_MIN_RETAINED_BLOCKS = 9_000;
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
  // The ORDER above is this module's meaning (children before blocks, per the
  // comment) -- so this cannot alias the hot tier's list. The satisfies
  // clause pins every member to CHAIN_DETAIL_HOT_TIER_TABLES, and
  // PruneCoversHotTier makes a table added to the hot tier but missing here a
  // type error: a table served but never pruned grows without bound.
] as const satisfies readonly (typeof CHAIN_DETAIL_HOT_TIER_TABLES)[number][];
type PruneCoversHotTier =
  Exclude<
    (typeof CHAIN_DETAIL_HOT_TIER_TABLES)[number],
    (typeof PRUNE_TABLES)[number]
  > extends never
    ? true
    : never;
const _pruneCoversHotTier: PruneCoversHotTier = true;
void _pruneCoversHotTier;

export interface PruneWindow {
  /** Lowest block the tier should still hold. */
  keepFrom: number;
  /** Retained depth in blocks, after the floor/ceiling clamp. */
  retainedBlocks: number;
  /**
   * The same, for `chain_detail_account_events` alone -- see
   * ACCOUNT_EVENTS_MIN_RETAINED_BLOCKS for why one table needs its own.
   *
   * NEVER ABOVE `keepFrom`: a deeper floor may only keep MORE rows, so an
   * adaptive window that has already grown past it (a lagging decoder) still
   * governs. `Math.min` states that rather than leaving it to the caller.
   */
  accountEventsKeepFrom: number;
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
  const keepFrom = head - retainedBlocks + 1;
  // The ceiling is deliberately NOT applied here. It bounds how far a stalled
  // DECODER can push retention, which is the runaway this tier guards against;
  // this floor is a fixed depth chosen against the producer's fold cadence and
  // cannot run away on its own.
  return {
    keepFrom,
    retainedBlocks,
    accountEventsKeepFrom: Math.min(
      keepFrom,
      head - ACCOUNT_EVENTS_MIN_RETAINED_BLOCKS + 1,
    ),
  };
}

export interface ChainDetailPruneResult {
  ok: boolean;
  reason?: string;
  /** The error text, when the run failed against a bound database. */
  detail?: string;
  /** The window this run computed, absent when nothing could be computed. */
  keep_from?: number;
  retained_blocks?: number;
  /** Exclusive upper bound of the range this run actually deleted. */
  deleted_below?: number;
  /** How many blocks this run removed, capped per run. */
  blocks_pruned?: number;
  /** Whether the SAME bound was applied to Neon, and what happened if not.
   * Reported separately because the two stores prune INDEPENDENTLY -- see the
   * runner. */
  neon_pruned?: boolean;
  neon_detail?: string;
}

/**
 * One prune tick.
 *
 * Returns a summary rather than throwing, matching the cron family: a tick that
 * cannot run is one missed report, not an outage.
 */
export interface ChainDetailPruneDeps {
  /** Injectable Postgres runner, so the Neon half is testable without a
   * database -- the same escape hatch src/neon-prune.ts takes. */
  sql?: { unsafe(text: string, values?: unknown[]): Promise<unknown> } | null;
  /** Injectable bounds reader, for the same reason: the MIN/MAX that every
   * number here is derived from follows the rows (#10152). */
  readDb?: ReadStoreDb | null;
}

export async function pruneChainDetail(
  env: unknown,
  ctx?: WaitUntilLike,
  deps: ChainDetailPruneDeps = {},
): Promise<ChainDetailPruneResult> {
  // THE WATERMARK MUST COME FROM THE STORE THAT HOLDS THE ROWS (#10152).
  //
  // Every number below is derived from one MIN/MAX read, and that read used to
  // be D1's unconditionally. Once the chain-detail lane inverted, D1 stopped
  // advancing -- so Neon's retention watermark was pinned to a frozen floor,
  // and the tier it is supposed to bound grew without limit. Reading through
  // readStore is what keeps the bound following the rows.
  const reader = readStore(env, PRUNE_TABLES, deps.readDb);
  if (!reader?.first) return { ok: false, reason: "no store bound" };

  try {
    const bounds = (await reader.first(
      "SELECT MIN(block_number) AS floor, MAX(block_number) AS head " +
        "FROM chain_detail_blocks",
    )) as { floor?: unknown; head?: unknown } | null;
    const floor = safeIntOrNull(bounds?.floor);
    const head = safeIntOrNull(bounds?.head);
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
    // The account-events bound rides the SAME per-run cap, so a deeper floor
    // cannot turn one run into an unbounded delete -- it only stops that table
    // being taken as far as the others.
    const accountEventsDeletedBelow = Math.min(
      window.accountEventsKeepFrom,
      floor + CHAIN_DETAIL_PRUNE_MAX_BLOCKS_PER_RUN,
    );
    const neon = await pruneChainDetailNeon(
      env,
      ctx,
      deletedBelow,
      deps,
      accountEventsDeletedBelow,
    );
    return {
      ok: true,
      keep_from: window.keepFrom,
      retained_blocks: window.retainedBlocks,
      deleted_below: deletedBelow,
      blocks_pruned: deletedBelow - floor,
      ...neon,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "prune_failed",
      ...(err instanceof Error ? { detail: err.message } : {}),
    };
  }
}

/**
 * The SAME bound, applied to Neon.
 *
 * WHY THE BOUND IS PASSED IN AND NEVER RECOMPUTED (#10017). This is the one
 * decision the whole function exists to make. `src/neon-prune.ts` expresses
 * retention as a time window -- a column plus a `retentionMs` -- and this tier
 * does not have one: `chainDetailPruneWindow` derives an adaptive BLOCK
 * watermark from the lane head and how far back the lakehouse has not reached,
 * clamped, recomputed every run. No `retentionMs` reproduces it, because block
 * production is not constant and the seam moves independently of the clock.
 *
 * Recomputing a bound per store would be worse than not pruning at all. A
 * wider Neon window keeps blocks D1 had dropped and `neon-parity` reports a
 * permanent surplus; a narrower one drops blocks the hot tier is still
 * expected to serve and the read cutover silently loses coverage at the seam.
 * Both states look like an in-flight backfill rather than a design error,
 * which is why this takes `deletedBelow` as an argument: one resolution per
 * run, so the two stores cannot disagree about the window even transiently.
 *
 * THE STORES STILL PRUNE INDEPENDENTLY. A Neon failure is reported and
 * swallowed, never rethrown -- blocking the store's retention on Neon's availability
 * would freeze the surviving store's window, which is the same reasoning
 * health-prober.ts:949 already applies to its own two-store prune. D1 had
 * already deleted by the time this runs; the worst case is Neon holding a
 * little extra until the next tick, which the next tick fixes.
 *
 * THE GATE ASKS WHETHER NEON HOLDS THESE ROWS, not whether something is
 * reconciling them (#10084). It was `neonBackfillLanes` alone, which was wrong
 * in both directions:
 *
 *   * On the main Worker, where this actually runs, NEON_BACKFILL_LANES was
 *     undefined -- `vars` are per-config -- so the set was empty and this
 *     returned before opening a connection, every tick, forever. Neon was
 *     measured holding 1,499 blocks BELOW the store's floor and growing.
 *   * #10078 established that a table LEAVES the backfill lanes exactly when
 *     Neon becomes its sole store. So the old gate would have switched the
 *     prune off at the precise moment Neon held the only copy -- a second,
 *     worse no-op waiting at the end of the migration.
 *
 * Reconciled OR solely owned both mean "Neon has rows here", which is the only
 * question a prune needs answered. A table that is neither still costs nothing:
 * the connection is skipped rather than opened for a DELETE matching nothing.
 */
async function pruneChainDetailNeon(
  env: unknown,
  ctx: WaitUntilLike | undefined,
  deletedBelow: number,
  deps: ChainDetailPruneDeps,
  /** The bound for `chain_detail_account_events`, which keeps more. */
  accountEventsDeletedBelow: number,
): Promise<{ neon_pruned?: boolean; neon_detail?: string }> {
  const bag = env as Record<string, unknown> | null | undefined;
  const hyperdrive = bag?.HYPERDRIVE as HyperdriveLike | undefined;
  const injected = deps.sql;
  if (!injected && (!hyperdrive?.connectionString || !ctx)) return {};
  // Every one of the four, or none: they are pruned to a single watermark and
  // a partially-listed set would leave one table holding blocks its siblings
  // dropped -- a join across the seam would then find a block header with no
  // events, which reads as corruption rather than as retention.
  // Ownership alone since #10166 deleted the reconciler: the second arm was
  // "or it is being backfilled", and there is no backfill any more.
  // the ownership check collapsed with the flag (#10051): Neon is the only store, so the question answered itself.
  try {
    const sql = injected ?? createPgSql(hyperdrive!, ctx!);
    for (const table of PRUNE_TABLES) {
      // ONE table keeps more, and the bound is chosen per table rather than by
      // running the loop twice: two DELETE passes over the same list is where a
      // future table gets added to one and not the other.
      const below =
        table === "chain_detail_account_events"
          ? accountEventsDeletedBelow
          : deletedBelow;
      await sql.unsafe(`DELETE FROM ${table} WHERE block_number < $1`, [below]);
    }
    return { neon_pruned: true };
  } catch (err) {
    return {
      neon_pruned: false,
      neon_detail: err instanceof Error ? err.message : "neon prune failed",
    };
  }
}
