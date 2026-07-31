/** The exit quote state for one non-root position, keyed by the same index as
 *  the positions array passed to {@link exitTotals}. `ready` is the only
 *  variant that carries a number, so a caller can never accidentally sum a
 *  pending/errored slot -- there is nothing numeric to read from it. */
export type PositionQuoteState =
  | { phase: "pending" }
  | { phase: "error" }
  | { phase: "ready"; expectedOut: number };

export interface PositionForTotals {
  isRoot: boolean;
  spotTao: number;
}

export interface ExitTotals {
  spot: number;
  exit: number;
  root: number;
  alpha: number;
  /** Count of non-root positions excluded from `exit` because their quote errored. */
  excludedError: number;
  /** Count of non-root positions excluded from `exit` because their quote is still in flight. */
  excludedPending: number;
}

/**
 * Aggregate the wallet positions panel's three-tile totals.
 *
 * `exit` is never padded with a position's `spotTao` when its AMM quote is
 * pending or has failed: an unstake quote is fee + slippage adjusted and so
 * is always `<= spot`, meaning the substitution could only overstate the
 * realizable total. Root positions have no AMM -- they're 1:1 by definition,
 * so they're summed into `exit` directly and never counted in either
 * exclusion counter.
 */
export function exitTotals(
  positions: ReadonlyArray<PositionForTotals>,
  quoteStates: ReadonlyArray<PositionQuoteState>,
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
    if (state.phase === "ready") {
      exit += state.expectedOut;
    } else if (state.phase === "error") {
      excludedError += 1;
    } else {
      excludedPending += 1;
    }
  });

  return { spot, exit, root, alpha, excludedError, excludedPending };
}
