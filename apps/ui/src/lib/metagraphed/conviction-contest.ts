import type { SubnetConvictionEntry } from "./types";

export type ContestStatus = "secure" | "contested" | "takeover-imminent";

export interface ContestGap {
  status: ContestStatus;
  /** Gap between the king and the top challenger, as a percentage of the king's conviction.
   * Null when there's no challenger to compare against, or the king's conviction is 0. */
  gapPct: number | null;
}

// Gap thresholds, expressed as % of the king's conviction (#6883). There's no existing
// precedent for this in the codebase -- these are a documented starting point, not derived
// from chain data: under 5% is close enough that a single strong lock top-up can close it
// within one epoch; 5-20% needs a sustained push while the king's own conviction keeps decaying
// in the meantime; above 20% is a lead a challenger can't realistically close in one epoch.
const TAKEOVER_IMMINENT_MAX_PCT = 5;
const CONTESTED_MAX_PCT = 20;

/**
 * Ownership-contest urgency for a conviction leaderboard: how close the top challenger is to
 * overtaking the king. Looks the king entry up by hotkey (falling back to the highest-conviction
 * entry if `king` doesn't match anything in `leaderboard`) and takes the highest-conviction
 * remaining entry as the runner-up -- correct regardless of the array's sort order.
 */
export function contestGap(leaderboard: SubnetConvictionEntry[], king: string | null): ContestGap {
  if (leaderboard.length === 0) return { status: "secure", gapPct: null };

  const kingEntry =
    (king != null ? leaderboard.find((e) => e.hotkey === king) : undefined) ??
    leaderboard.reduce((best, e) => (e.conviction > best.conviction ? e : best));

  const runnerUp = leaderboard
    .filter((e) => e.hotkey !== kingEntry.hotkey)
    .reduce<SubnetConvictionEntry | null>(
      (best, e) => (best == null || e.conviction > best.conviction ? e : best),
      null,
    );

  if (runnerUp == null || kingEntry.conviction <= 0) {
    return { status: "secure", gapPct: null };
  }

  const gapPct = ((kingEntry.conviction - runnerUp.conviction) / kingEntry.conviction) * 100;
  if (gapPct < TAKEOVER_IMMINENT_MAX_PCT) return { status: "takeover-imminent", gapPct };
  if (gapPct < CONTESTED_MAX_PCT) return { status: "contested", gapPct };
  return { status: "secure", gapPct };
}
