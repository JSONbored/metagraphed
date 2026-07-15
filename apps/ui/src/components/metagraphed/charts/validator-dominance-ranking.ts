import { shortHash } from "@/lib/metagraphed/blocks";

/**
 * Pure "shape the network-wide validator leaderboard into chart-ready rows"
 * logic for the validator-dominance chart (#2565). Kept separate from the
 * rendering component so the ranking + tie-break rules get direct unit
 * coverage without a React render.
 */

/** Default number of validators the dominance chart surfaces. */
export const VALIDATOR_DOMINANCE_TOP_N = 10;

/** Minimal shape this module needs from a `GlobalValidator` row. */
export interface ValidatorDominanceSource {
  hotkey: string;
  coldkey_identity?: { name: string | null } | null;
  total_stake_tao: number;
  stake_dominance: number | null;
  subnet_count: number;
}

/** One chart-ready row — BarMini and TreemapMini both accept `{ label, value, color? }`. */
export interface ValidatorDominanceDatum {
  hotkey: string;
  label: string;
  /** Stake share of the network total, as a percentage (0–100) rounded for display. */
  value: number;
  /** Same share as the raw 0–1 fraction, for callers that want the unrounded number. */
  share: number;
  stakeTao: number;
  subnetCount: number;
}

/**
 * Rank validators by network-wide stake share (`stake_dominance`) and take
 * the top `limit`. `stake_dominance` is precomputed server-side against the
 * FULL network total — it is NOT derivable client-side from this payload
 * alone, since the payload itself is already truncated to `limit` rows (the
 * same reason `ValidatorsTableLoader`'s per-subnet treemap derives shares
 * from a local top-N sum instead: no network-wide total travels with a
 * truncated set). Rows with no known share (null, zero, or negative) are
 * excluded rather than sorted to the bottom — a dominance chart has nothing
 * meaningful to plot for an unknown share.
 *
 * Deterministic tie-break: stake_dominance desc -> total_stake_tao desc ->
 * hotkey asc, so equal-share rows always render in the same order.
 */
export function buildValidatorDominanceChartData(
  validators: readonly ValidatorDominanceSource[],
  limit: number = VALIDATOR_DOMINANCE_TOP_N,
): ValidatorDominanceDatum[] {
  const ranked = validators
    .filter(
      (v): v is ValidatorDominanceSource & { stake_dominance: number } =>
        typeof v.stake_dominance === "number" && v.stake_dominance > 0,
    )
    .sort((a, b) => {
      const shareDiff = b.stake_dominance - a.stake_dominance;
      if (shareDiff !== 0) return shareDiff;
      const stakeDiff = b.total_stake_tao - a.total_stake_tao;
      if (stakeDiff !== 0) return stakeDiff;
      return a.hotkey.localeCompare(b.hotkey);
    });

  return ranked.slice(0, Math.max(0, limit)).map((v) => {
    const identityName = v.coldkey_identity?.name?.trim();
    return {
      hotkey: v.hotkey,
      label:
        identityName && identityName.length > 0 ? identityName : (shortHash(v.hotkey) ?? v.hotkey),
      share: v.stake_dominance,
      value: Number((v.stake_dominance * 100).toFixed(2)),
      stakeTao: v.total_stake_tao,
      subnetCount: v.subnet_count,
    };
  });
}
