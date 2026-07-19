/**
 * Ownership-contest framing for a subnet's conviction leaderboard (#6883).
 *
 * `conviction` is the exponentially-smoothed integral of locked_mass that
 * actually determines the on-chain ownership flip (see the SubnetConviction
 * type + docs/conviction-lock-mechanism.md). The "how close is the contest"
 * signal three surveyed explorers independently built is a single number: how
 * far ahead the leader is vs the top challenger, as a share of the leader's own
 * conviction. This is a pure presentation derivation over already-fetched data.
 */
export type ConvictionContestStatus = "secure" | "contested" | "takeover-imminent";

export interface ConvictionContest {
  /** Leader-vs-top-challenger gap as a % of the leader's conviction, or null
   *  when there is no challenger (0 or 1 entries, or a non-positive leader). */
  gapPct: number | null;
  status: ConvictionContestStatus;
}

// Thresholds are a presentation choice (no on-chain precedent to mirror):
//  - <= 5%: the challenger is within a small roll-forward of the leader, so a
//    few blocks of the governance unlock/maturity rates could flip ownership —
//    the case actually worth flagging as urgent.
//  - <= 25%: the challenger holds > 3/4 of the leader's conviction — a genuine
//    contest, but not imminent.
//  - otherwise (or no challenger): a commanding lead — secure.
export const CONVICTION_TAKEOVER_GAP_PCT = 5;
export const CONVICTION_CONTESTED_GAP_PCT = 25;

/**
 * Derive the contest gap% + status from a conviction leaderboard. Order-agnostic
 * (ranks by `conviction`, so it does not assume the array is pre-sorted), and
 * NaN-safe (non-finite convictions are treated as 0).
 */
export function convictionContest(
  leaderboard: readonly { conviction: number }[],
): ConvictionContest {
  const convictions = leaderboard
    .map((e) => (Number.isFinite(e.conviction) ? e.conviction : 0))
    .sort((a, b) => b - a);

  const leader = convictions[0];
  const challenger = convictions[1];
  // No challenger (0/1 entry) or a non-positive leader -> uncontested.
  if (convictions.length < 2 || !(leader > 0)) {
    return { gapPct: null, status: "secure" };
  }

  const gapPct = ((leader - challenger) / leader) * 100;
  const status: ConvictionContestStatus =
    gapPct <= CONVICTION_TAKEOVER_GAP_PCT
      ? "takeover-imminent"
      : gapPct <= CONVICTION_CONTESTED_GAP_PCT
        ? "contested"
        : "secure";
  return { gapPct, status };
}
