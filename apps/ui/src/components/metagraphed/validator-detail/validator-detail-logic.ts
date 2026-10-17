/**
 * The derivations behind /validators/$hotkey (#11617).
 */
import type { ValidatorDetailSubnet, ValidatorNominatorEntry } from "@/lib/metagraphed/types";
import { formatAmount, formatDecimal } from "@/lib/metagraphed/format";

export const shortKey = (key: string): string =>
  key.length > 14 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;

export const fmtStake = (value: number | null | undefined): string => formatAmount(value, "τ");

export const fmtAlpha = (value: number | null | undefined): string => formatAmount(value, "α");

export const fmtScore = (value: number | null | undefined): string => formatDecimal(value, 3);

/** Keep memberships identifiable without comparing weight across subnets. */
export function membershipsBySubnet(
  subnets: readonly ValidatorDetailSubnet[],
): ValidatorDetailSubnet[] {
  return [...subnets].sort((a, b) => a.netuid - b.netuid || a.uid - b.uid);
}

export interface NominatorRow {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}
/**
 * Nominators ranked by observed gross movement during the window.
 *
 * `net_staked_tao` is the window's NET movement, which is a different
 * question and goes negative for anyone unwinding. Ranking "who delegates
 * here" by it would put the largest departing delegator last.
 */
export function nominatorRail(
  nominators: readonly ValidatorNominatorEntry[],
  limit = 20,
): NominatorRow[] {
  return nominators
    .map((nominator) => ({
      key: nominator.coldkey,
      label: shortKey(nominator.coldkey),
      value: nominator.gross_staked_tao,
      href: `/accounts/${nominator.coldkey}`,
      detail: [
        { key: "staked", label: "Staked in", value: fmtStake(nominator.staked_tao) },
        { key: "unstaked", label: "Unstaked out", value: fmtStake(nominator.unstaked_tao) },
        { key: "net", label: "Net", value: fmtStake(nominator.net_staked_tao) },
        { key: "events", label: "Events", value: String(nominator.event_count ?? 0) },
      ],
    }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

