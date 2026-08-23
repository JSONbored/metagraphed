/**
 * The derivations behind /validators/$hotkey (#11617).
 */
import type {
  ValidatorDetailSubnet,
  ValidatorHistoryPoint,
  ValidatorNominatorEntry,
} from "@/lib/metagraphed/types";

export type ValidatorWindow = "7d" | "30d" | "90d";

export const shortKey = (key: string): string =>
  key.length > 14 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;

export const fmtStake = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M τ`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k τ`;
  return `${value.toFixed(2)} τ`;
};

export const fmtAlpha = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M α`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k α`;
  return `${value.toFixed(2)} α`;
};

export const fmtScore = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";

export interface StakeColumn {
  key: string;
  label: string;
  axisLabel: string;
  total: number;
  segments: { key: string; label: string; value: number }[];
}

/**
 * Stake by subnet as one column per membership, biggest first.
 *
 * NOT a time series. `/validators/{hotkey}/history` publishes network-wide
 * daily totals with `netuid: null` -- there is no per-subnet daily series to
 * stack, and drawing one would mean inventing it. What the data supports is
 * the composition right now, which is the question "where is the stake"
 * actually asks. Momentum below carries the time dimension.
 */
export function stakeBySubnet(
  subnets: readonly ValidatorDetailSubnet[],
  nameOf: (netuid: number) => string,
  top = 12,
): StakeColumn[] {
  const rows = subnets
    .map((subnet) => ({
      netuid: subnet.netuid,
      stake: typeof subnet.stake_alpha === "number" ? subnet.stake_alpha : 0,
      emission: typeof subnet.emission_alpha === "number" ? subnet.emission_alpha : 0,
    }))
    .filter((row) => row.stake > 0 || row.emission > 0)
    .sort((a, b) => b.stake - a.stake)
    .slice(0, top);

  return rows.map((row) => ({
    key: `sn-${row.netuid}`,
    label: nameOf(row.netuid),
    axisLabel: `SN${row.netuid}`,
    total: row.stake + row.emission,
    segments: [
      { key: "stake", label: "Stake", value: row.stake },
      { key: "emission", label: "Emission", value: row.emission },
    ],
  }));
}

/** History points → chronological line points for one measured field. */
export function historyPoints(
  points: readonly ValidatorHistoryPoint[],
  pick: (point: ValidatorHistoryPoint) => number | null | undefined,
): { t: number; v: number }[] {
  return points
    .map((point) => {
      const value = pick(point);
      const t = Date.parse(`${point.snapshot_date}T00:00:00Z`);
      return typeof value === "number" && Number.isFinite(value) && Number.isFinite(t)
        ? { t, v: value }
        : null;
    })
    .filter((point): point is { t: number; v: number } => point !== null)
    .sort((a, b) => a.t - b.t);
}

/**
 * Annualised yield from the daily rewards-per-1000-TAO the history publishes.
 *
 * Simple annualisation, not compounded: the series is a daily reward rate
 * measured per 1,000 τ staked, and compounding it would state a return the
 * validator did not produce.
 */
export function apyPoints(points: readonly ValidatorHistoryPoint[]): { t: number; v: number }[] {
  return historyPoints(points, (point) =>
    typeof point.rewards_per_1000_tao === "number"
      ? (point.rewards_per_1000_tao / 1000) * 365
      : null,
  );
}

/** Fractional change across a series, or null when it cannot be measured. */
export function changeOver(points: readonly { v: number }[]): number | null {
  const first = points[0]?.v;
  const last = points[points.length - 1]?.v;
  if (first === undefined || last === undefined || first === 0) return null;
  return (last - first) / first;
}

export interface NominatorRow {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}

/**
 * Nominators ranked by what they currently have here.
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

export interface PeerRow {
  key: string;
  label: string;
  value: string;
  href: string;
  current: boolean;
}

/**
 * The operators ranked either side of this one by stake.
 *
 * A window centred on the subject, clamped at both ends -- "who am I next
 * to" has no answer at the top of a list otherwise, and showing the top N
 * instead would answer a question nobody asked.
 */
export function peerWindow(
  ranked: readonly { hotkey: string; name: string; totalStakeTao: number }[],
  hotkey: string,
  span = 11,
): PeerRow[] {
  const index = ranked.findIndex((row) => row.hotkey === hotkey);
  const half = Math.floor(span / 2);
  const start =
    index < 0 ? 0 : Math.max(0, Math.min(index - half, Math.max(0, ranked.length - span)));
  return ranked.slice(start, start + span).map((row) => ({
    key: row.hotkey,
    label: row.name,
    value: fmtStake(row.totalStakeTao),
    href: `/validators/${row.hotkey}`,
    current: row.hotkey === hotkey,
  }));
}
