/** The minimal shape {@link exitTotals} needs from a position -- structurally satisfied by
 *  `UnifiedPosition` (`components/metagraphed/your-positions-panel.tsx`) without a cast. */
export interface PositionSpot {
  spotTao: number;
  isRoot: boolean;
}

/** A non-root position's AMM exit-quote state, aligned index-for-index with the positions array.
 *  `phase` is derived per position via `statPhase` (`stat-phase.ts`) from its `useQueries` result. */
export interface PositionQuoteState {
  phase: "pending" | "error" | "ready";
  expectedOut: number | null;
}

export interface ExitTotals {
  spot: number;
  exit: number;
  root: number;
  alpha: number;
  /** Non-root positions excluded from `exit` because their quote request failed. */
  excludedError: number;
  /** Non-root positions excluded from `exit` because their quote is still in flight. */
  excludedPending: number;
}

/**
 * Aggregate spot/exit/root/alpha totals across a wallet's positions. `exit` is NEVER padded with a
 * position's un-slipped spot value when its AMM exit quote is pending or errored -- an exit quote is
 * always <= spot (fee + slippage can only reduce the output), so substituting spot can only overstate
 * realizable value (#8819). A root position has no AMM (1:1 by definition) and is always included at
 * its spot value regardless of its quoteState -- it is never counted as excluded.
 */
/**
 * A non-root position with no positive alpha amount (`buildUnifiedPositions`
 * leaves `alpha` null when a subnet's price is unknown) never has its exit
 * quote enabled -- `your-positions-panel.tsx`'s `useQueries` sets
 * `enabled: Boolean(p.alpha && p.alpha > 0)`, and TanStack Query leaves a
 * disabled query's `isPending` permanently true, so `statPhase()` on it would
 * report "pending" forever. Treat it as "error" (unavailable) instead -- it
 * can never resolve, matching `exitTaoFor`'s own per-row `null` for this
 * case -- so the "Simulated exit" tile can't get stuck rendering a skeleton
 * indefinitely.
 */
export function quotePhase(
  position: Pick<PositionSpot, "isRoot"> & { alpha: number | null },
  queryPhase: "pending" | "error" | "ready",
): "pending" | "error" | "ready" {
  if (!position.isRoot && !(position.alpha && position.alpha > 0)) return "error";
  return queryPhase;
}

export function exitTotals(
  positions: readonly PositionSpot[],
  quoteStates: readonly PositionQuoteState[],
): ExitTotals {
  let spot = 0;
  let exit = 0;
  let root = 0;
  let alpha = 0;
  let excludedError = 0;
  let excludedPending = 0;

  positions.forEach((p, i) => {
    spot += p.spotTao;
    if (p.isRoot) {
      root += p.spotTao;
      exit += p.spotTao;
      return;
    }
    alpha += p.spotTao;
    const state = quoteStates[i];
    if (state?.phase === "ready" && typeof state.expectedOut === "number") {
      exit += state.expectedOut;
    } else if (state?.phase === "error") {
      excludedError += 1;
    } else {
      excludedPending += 1;
    }
  });

  return { spot, exit, root, alpha, excludedError, excludedPending };
}
