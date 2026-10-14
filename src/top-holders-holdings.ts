// The HOLDINGS leg of GET /api/v1/accounts/top-holders: free_tao,
// delegated_tao and total_tao, composed live beside the flow columns (#9502).
//
// TWO CALLERS SINCE #9632, on two cadences: the daily flow lane, which rebuilds
// the whole artifact, and src/top-holders-holdings-refresh.ts, which runs this
// alone every three hours and merges the result onto the flow ranking already
// published. Nothing here changes between them -- this leg selects its own
// top-N over the FULL tables either way, which is exactly why the refresh is
// not a subset of a stale row set.
//
// WHAT THIS REPLACES. All three came from src/top-holders-artifact.ts's
// one-shot 2026-08-02 materialization, whose `captured_at` is a fixed date
// rather than a refresh clock: an account that moved TAO since was misreported
// and one first funded since was absent entirely.
//
// WHY delegated_tao NEEDED A NEW TABLE RATHER THAN A JOIN. A coldkey's
// `nominator_positions.share_fraction` is a DIMENSIONLESS slice of a
// (hotkey, netuid) alpha pool. Valuing it needs that pool's total, and the only
// stake figure D1 held was `neurons.stake_tao` -- which exists solely for
// hotkeys holding a UID on that exact subnet. A delegate accrues alpha on every
// subnet it is staked to, registered there or not, so the join reaches 512 of
// the 13,724 pairs the positions name: 22.8% of position rows. Ranking off that
// puts an account the frozen snapshot values at 81,185 TAO at 0 and drops
// another out of the payload entirely -- confidently wrong about who the top
// holders are, which is worse than the frozen figure it would replace. #9502
// captured `SubtensorModule::TotalHotkeyAlpha` into `hotkey_alpha` instead.
//
// THE PRICING, and the one rule that is not arithmetic:
//
//   position_tao = share_fraction * hotkey_alpha.total_alpha * alpha_price_tao
//
// `total_alpha` is ALPHA (0019 stores the unit the producer measured), and the
// netuid's `alpha_price_tao` comes from the newest `subnet_snapshots` row for
// that subnet -- a daily cadence, so a position is priced at up to a day-old
// rate. That skew is a property of the price source, not a defect here, and it
// is why an acceptance check against a live TotalHotkeyAlpha read should expect
// agreement to within a day of price movement rather than to the rao.
//
// A NETUID WITH NO USABLE PRICE IS EXCLUDED FROM THE SUM, NEVER COUNTED AS
// ZERO. Both joins below are INNER for exactly this reason: an unpriceable
// netuid drops its positions out of the addition rather than contributing 0,
// because "we could not value this" and "this is worth nothing" are different
// facts and only one of them is true. Today 127 netuids carry a usable price
// and all 113 the positions name are among them, so the exclusion is a no-op --
// it is here for the day one of them loses its price, which is the day a
// COALESCE(...,0) would silently understate a holder.
//
// WHY total_tao IS NOT free_tao + delegated_tao OVER THE OTHER TWO LEGS' ROWS.
// Each leg keeps its own top-N, and the top-N by a SUM is not contained in the
// union of the top-Ns of its addends: an account outside both can still have a
// total up to twice the cutoff. So the sum is computed across the FULL tables
// and ranked there, and the three top-N selections are taken from that one
// aggregate. Composing it from the capped maps would drop real top holders and
// look perfectly well-formed doing it.
//
// EVERY COLUMN IS GATED ON ITS OWN INPUT'S COMPLETENESS, and total_tao on both.
// A partial ledger does not produce a visibly broken ranking, it produces a
// plausible wrong one -- see src/account-balances-completeness.ts and
// src/hotkey-alpha-completeness.ts for why a row count cannot answer this and
// the producers declare their pass sizes instead.

import { readStore } from "./read-store.ts";
import { TOP_HOLDERS_HOLDINGS_TABLES } from "./read-store-tables.ts";
import {
  latestCompleteAccountBalancesPass,
  mayRankAccountBalances,
} from "./account-balances-completeness.ts";

/** The holdings sorts, in the order the artifact declares them. */
export const TOP_HOLDERS_FREE_SORT = "free_tao";
export const TOP_HOLDERS_DELEGATED_SORT = "delegated_tao";
export const TOP_HOLDERS_TOTAL_SORT = "total_tao";

/**
 * How many rows each holdings sort contributes.
 *
 * Matches TOP_HOLDERS_FLOW_ROW_CAP and the frozen artifact's own
 * union-of-top-1,000-per-key shape, so every `?limit=` up to the route's max of
 * 100 is a slice of the same total order regardless of which tier answered.
 */
export const TOP_HOLDERS_HOLDINGS_ROW_CAP = 1_000;

/** One account's proven holdings cells. A key is ABSENT when its leg did not
 * run -- never 0, which is reserved for a measured zero (#9066/#9273/#9305). */
export interface HoldingsCells {
  free_tao?: number;
  delegated_tao?: number;
  total_tao?: number;
}

export interface HoldingsLeg {
  cells: Map<string, HoldingsCells>;
  /** The holdings sorts this leg proved it can rank. */
  sorts: string[];
  /**
   * How old these numbers are: the OLDEST input pass they rest on.
   *
   * Not the clock at compute time, which is what a lane stamp would be and
   * would overstate freshness by however long the producer has been quiet --
   * measured 2026-08-15, `account_balances`' newest complete pass was 5 h old
   * when read, so a lane-clock stamp would have announced 0 minutes. The
   * refresh lane exists precisely to make this number small, so it has to be
   * the number that can fail to get smaller.
   *
   * OLDEST rather than newest because the columns are consumed together and
   * `total_tao` -- the default sort -- is a sum of both legs: a total is
   * exactly as current as its stalest addend. When only one leg is proven
   * there is only one stamp to take.
   */
  capturedAt: number;
}

/**
 * The balance ledger's own rows.
 *
 * NOT scoped to the complete pass's captured_at, matching
 * src/top-holders-flow-tier.ts's balances read and for its reason: this ledger
 * never prunes, so once any complete pass has landed the table holds at least
 * that whole account set, and scoping would drop exactly the accounts a newer
 * partial pass had refreshed.
 */
const FREE_CTE =
  "bal AS (SELECT ss58, free_tao FROM account_balances WHERE free_tao > 0)";

/**
 * The one statement, composed from whichever legs are proven.
 *
 * Every value interpolated here is a module constant or a number this module
 * read out of D1 itself -- never caller input.
 *
 * Exported because it is the part worth testing directly: which CTEs appear,
 * which columns are selected, and which top-N selections union into the row set
 * are the whole contract, and all three are decidable from the string.
 */
export function topHoldersHoldingsSql(
  opts: {
    free: boolean;
    delegated: boolean;
    alphaCapturedAt?: number | null;
  },
  cap: number = TOP_HOLDERS_HOLDINGS_ROW_CAP,
): string {
  if (!opts.free || opts.delegated)
    throw new TypeError("Native delegated valuation is unqualified");
  if (
    !Number.isSafeInteger(cap) ||
    cap < 1 ||
    cap > TOP_HOLDERS_HOLDINGS_ROW_CAP
  )
    throw new TypeError("Invalid bounded holdings page");
  return `WITH ${FREE_CTE} SELECT ss58,free_tao FROM bal ORDER BY free_tao DESC,ss58 ASC LIMIT ${cap}`;
}

/** A finite, non-negative holdings figure, or null. Unlike a net flow, a
 * holding cannot be negative: a negative here is a broken read, not a
 * measurement. */
function holding(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The proven holdings columns, or null to leave all three out of the artifact.
 *
 * Returns the sorts it actually ranked rather than a fixed list, so "which
 * holdings columns are live" is a property of the run -- the same
 * decline-while-unproven switch the flow tier's balance leg uses, extended to
 * three columns that can each become provable on a different day.
 */
export async function topHoldersHoldings(
  env: Env | null | undefined,
  cap: number = TOP_HOLDERS_HOLDINGS_ROW_CAP,
): Promise<HoldingsLeg | null> {
  // readStore, NOT observationsReadDb (#10179), for the same pair of reasons
  // src/subnet-weight-setters-loader.ts gives: that selector needs an
  // ExecutionContext to reach Neon, and this lane has none to give -- its
  // caller is ProjectionLane.compute(env, network), so there is no ctx anywhere
  // in the chain and threading one is not the fix. Its Neon handle also lacks
  // the `first()` the two completeness readers below call, and resolves `all()`
  // to a bare array where the guard here expects `{ results }`.
  //
  // The failure is silent in the shape this whole module is careful about: a
  // null leg drops free_tao / delegated_tao / total_tao from the published
  // artifact entirely, which reads as "these sorts are unavailable" rather than
  // as a broken read.
  const db = readStore(env, TOP_HOLDERS_HOLDINGS_TABLES);
  if (!db?.query) return null;

  // The two readers describe the same binding with different minimal shapes --
  // this module's OptionalRowStore names bind()/all(), the completeness readers name
  // first() -- so the casts go through unknown rather than widening either
  // interface to satisfy the other.
  const balances = await latestCompleteAccountBalancesPass(db);
  if (!mayRankAccountBalances(balances)) return null;
  try {
    const results = await db.query<Record<string, unknown>>(
      topHoldersHoldingsSql({ free: true, delegated: false }, cap),
    );
    const cells = new Map<string, HoldingsCells>();
    for (const raw of results) {
      const ss58 = typeof raw.ss58 === "string" ? raw.ss58 : null;
      const free = holding(raw.free_tao);
      if (ss58 && free !== null) cells.set(ss58, { free_tao: free });
    }
    return cells.size
      ? {
          cells,
          sorts: [TOP_HOLDERS_FREE_SORT],
          capturedAt: balances.capturedAt!,
        }
      : null;
  } catch {
    return null;
  }
}
