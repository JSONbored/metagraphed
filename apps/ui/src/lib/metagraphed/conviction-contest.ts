import type { SubnetConvictionEntry } from "./types";

export type ContestStatus = "secure" | "contested" | "takeover-imminent" | "uncontested";

export interface ContestSummary {
  status: ContestStatus;
  /** The king entry (highest rolled conviction), or null when the leaderboard is empty. */
  king: SubnetConvictionEntry | null;
  /** The top non-king challenger, or null when the king is uncontested. */
  challenger: SubnetConvictionEntry | null;
  /** Gap between king and challenger, as a percentage of the king's conviction.
   *  Null when there's no challenger, or the king's conviction is 0. */
  gapPct: number | null;
}

// Gap thresholds, expressed as % of the king's conviction (#6883). There's no
// prior precedent for this in the codebase -- these are a documented starting
// point rather than a chain-derived figure: at or below 5% is close enough
// that a single strong lock top-up can flip within one epoch; the 5-20% band
// needs a sustained push while the king's own conviction keeps decaying;
// 20% or wider is a lead a challenger can't realistically close inside one epoch.
export const TAKEOVER_IMMINENT_MAX_PCT = 5;
export const CONTESTED_MAX_PCT = 20;

/**
 * Ownership-contest urgency for a conviction leaderboard: how close the top
 * challenger is to overtaking the king. Looks the king up by hotkey (falling
 * back to the highest-conviction entry if `king` doesn't match anything), then
 * takes the highest-conviction remaining entry as the runner-up -- correct
 * regardless of array order.
 */
export function summarizeContest(
  leaderboard: SubnetConvictionEntry[],
  king: string | null,
): ContestSummary {
  if (leaderboard.length === 0) {
    return { status: "uncontested", king: null, challenger: null, gapPct: null };
  }

  const kingEntry =
    (king != null ? leaderboard.find((e) => e.hotkey === king) : undefined) ??
    leaderboard.reduce((best, e) => (e.conviction > best.conviction ? e : best));

  const challenger = leaderboard
    .filter((e) => e.hotkey !== kingEntry.hotkey)
    .reduce<SubnetConvictionEntry | null>(
      (best, e) => (best == null || e.conviction > best.conviction ? e : best),
      null,
    );

  if (challenger == null) {
    return { status: "uncontested", king: kingEntry, challenger: null, gapPct: null };
  }
  if (kingEntry.conviction <= 0) {
    return { status: "uncontested", king: kingEntry, challenger, gapPct: null };
  }

  const gapPct = ((kingEntry.conviction - challenger.conviction) / kingEntry.conviction) * 100;
  // Boundary rule: gapPct is compared with strict `<`, so gapPct === 5 lands
  // in "contested" (not "takeover-imminent") and gapPct === 20 lands in
  // "secure" (not "contested"). Matches the "below X" phrasing in the
  // threshold comment above.
  if (gapPct < TAKEOVER_IMMINENT_MAX_PCT) {
    return { status: "takeover-imminent", king: kingEntry, challenger, gapPct };
  }
  if (gapPct < CONTESTED_MAX_PCT) {
    return { status: "contested", king: kingEntry, challenger, gapPct };
  }
  return { status: "secure", king: kingEntry, challenger, gapPct };
}
