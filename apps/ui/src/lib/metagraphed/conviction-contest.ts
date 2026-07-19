import type { SubnetConvictionEntry } from "./types";

// Contest-status thresholds -- how close is the ownership race?
//
// There's no existing precedent for these thresholds in the codebase, so
// they're documented starting points:
//   - "takeover-imminent" at <=5% because that's roughly the range a top
//     challenger could close within one governance-parameter maturity window
//     given typical UnlockRate/MaturityRate values (well inside a single
//     day of active locking).
//   - "contested" at <=20% because below a fifth-behind, a sustained
//     challenge is meaningfully in reach; above that the king's lead is
//     unlikely to flip without a large deliberate lock.
// Both are exported so a follow-up can tune them without hunting through
// component code.
export const TAKEOVER_IMMINENT_MAX_PCT = 5;
export const CONTESTED_MAX_PCT = 20;

export type ContestStatus = "uncontested" | "secure" | "contested" | "takeover-imminent";

export interface ContestSummary {
  status: ContestStatus;
  king: SubnetConvictionEntry | null;
  challenger: SubnetConvictionEntry | null;
  /**
   * Gap between king and top challenger as a percent of the king's conviction
   * (0-100). `null` when there is no challenger, or when the king's
   * conviction is 0 (a well-formed empty-contest state that can't be
   * expressed as a percentage).
   */
  gapPct: number | null;
}

/**
 * Pure summary of the current ownership contest for a subnet: king, top
 * challenger (if any), how far behind that challenger is, and a coarse
 * status band. See TAKEOVER_IMMINENT_MAX_PCT / CONTESTED_MAX_PCT above for
 * the thresholds. `king` is the `king` field from the API when present,
 * otherwise the first leaderboard entry (mirrors what the table itself
 * renders).
 */
export function summarizeContest(
  leaderboard: readonly SubnetConvictionEntry[],
  kingHotkey: string | null,
): ContestSummary {
  if (leaderboard.length === 0) {
    return { status: "uncontested", king: null, challenger: null, gapPct: null };
  }
  const king =
    (kingHotkey != null && leaderboard.find((e) => e.hotkey === kingHotkey)) || leaderboard[0];
  const challenger = leaderboard.find((e) => e.hotkey !== king.hotkey) ?? null;
  if (challenger == null) {
    return { status: "uncontested", king, challenger: null, gapPct: null };
  }
  if (king.conviction <= 0) {
    // A zero-conviction king with a challenger present is not a percent-
    // expressible contest; treat as contested (there IS a rival) but leave
    // gapPct null so the UI doesn't render "0%" or "NaN%".
    return { status: "contested", king, challenger, gapPct: null };
  }
  const gapPct = ((king.conviction - challenger.conviction) / king.conviction) * 100;
  let status: ContestStatus;
  if (gapPct <= TAKEOVER_IMMINENT_MAX_PCT) status = "takeover-imminent";
  else if (gapPct <= CONTESTED_MAX_PCT) status = "contested";
  else status = "secure";
  return { status, king, challenger, gapPct };
}

/**
 * Gap between a non-king row and the king, as a percent of the king's
 * conviction. Positive means "behind". `null` when the king's conviction
 * is 0 (can't express) or when comparing the king to themselves.
 */
export function rowGapPct(
  entry: SubnetConvictionEntry,
  king: SubnetConvictionEntry | null,
): number | null {
  if (king == null) return null;
  if (entry.hotkey === king.hotkey) return null;
  if (king.conviction <= 0) return null;
  return ((king.conviction - entry.conviction) / king.conviction) * 100;
}
