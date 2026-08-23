/**
 * The derivations behind / (#11618).
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type { ChainActivityDay, SubnetEconomics, SubnetMover } from "@/lib/metagraphed/types";
import { formatCompact, formatDecimal, formatPct } from "@/lib/metagraphed/format";

export type EmissionWindow = "7d" | "30d" | "90d";
export type ChainMetric = "extrinsics" | "events" | "blocks";

export const CHAIN_METRICS = [
  { value: "extrinsics", label: "Extrinsics" },
  { value: "events", label: "Events" },
  { value: "blocks", label: "Blocks" },
] as const;

export const fmtCount = (value: number | null | undefined): string => formatCompact(value);

export const fmtShare = (fraction: number | null | undefined, places = 2): string =>
  formatPct(fraction, places);

export interface ValueSegment {
  key: string;
  label: string;
  value: number;
  href?: string;
}

/**
 * Emission share as a composition of the whole network, today.
 *
 * NOT 56 days of columns. `/api/v1/economics/composition` does not exist --
 * no route serves a per-subnet daily price or emission series, and building
 * one from 129 per-subnet reads would be 129 requests for one chart. What
 * IS published is every subnet's current share, which answers "where is the
 * value going" with a measurement rather than an assembly.
 */
export function valueSegments(
  rows: readonly SubnetEconomics[],
  top = 10,
): { segments: ValueSegment[]; accounted: number } {
  const ranked = rows
    .filter((row) => typeof row.emission_share === "number" && row.emission_share > 0)
    .sort((a, b) => (b.emission_share ?? 0) - (a.emission_share ?? 0));
  const accounted = ranked.reduce((acc, row) => acc + (row.emission_share ?? 0), 0);
  const head = ranked.slice(0, top);
  const tail = ranked.slice(top);
  const segments: ValueSegment[] = head.map((row) => ({
    key: String(row.netuid),
    label: row.name ?? `SN${row.netuid}`,
    value: row.emission_share ?? 0,
    href: `/subnets/${row.netuid}`,
  }));
  if (tail.length > 0) {
    segments.push({
      key: RESIDUAL_KEY,
      label: `${tail.length} more subnets`,
      value: tail.reduce((acc, row) => acc + (row.emission_share ?? 0), 0),
    });
  }
  return { segments, accounted };
}

export interface EmissionRail {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}

/**
 * Subnets by emission over a window, with the change as detail.
 *
 * The LEVEL comes from the movers' end-of-window reading so the rail and its
 * change describe the same window; the current snapshot would describe a
 * different one and the two would disagree at every boundary.
 */
export function emissionRails(
  movers: readonly SubnetMover[],
  nameOf: (netuid: number) => string,
  limit = 15,
): EmissionRail[] {
  return movers
    .filter((mover) => Number.isFinite(mover.emission_end_alpha) && mover.emission_end_alpha > 0)
    .sort((a, b) => b.emission_end_alpha - a.emission_end_alpha)
    .slice(0, limit)
    .map((mover) => ({
      key: String(mover.netuid),
      label: nameOf(mover.netuid),
      value: mover.emission_end_alpha,
      href: `/subnets/${mover.netuid}`,
      detail: [
        { key: "share", label: "Share", value: fmtShare((mover.emission_share_pct ?? 0) / 100) },
        {
          key: "change",
          label: "Change",
          value:
            typeof mover.emission_pct_change === "number"
              ? `${mover.emission_pct_change >= 0 ? "+" : ""}${formatDecimal(mover.emission_pct_change, 1)}%`
              : "—",
        },
        { key: "validators", label: "Validators", value: String(mover.validators_end) },
      ],
    }));
}

/** Chain activity days → chronological points for one measured counter. */
export function chainPoints(
  days: readonly ChainActivityDay[],
  metric: ChainMetric,
): { t: number; v: number }[] {
  const pick = (day: ChainActivityDay) =>
    metric === "extrinsics"
      ? day.extrinsic_count
      : metric === "events"
        ? day.event_count
        : day.block_count;
  return days
    .map((day) => {
      const value = pick(day);
      const t = Date.parse(`${day.day}T00:00:00Z`);
      return typeof value === "number" && Number.isFinite(value) && Number.isFinite(t)
        ? { t, v: value }
        : null;
    })
    .filter((point): point is { t: number; v: number } => point !== null)
    .sort((a, b) => a.t - b.t);
}

/**
 * The most recent COMPLETE day.
 *
 * `/chain/activity`'s newest row is the day in progress -- 1,588 blocks
 * against a full day's 7,200 when read at 05:17 UTC -- and quoting it as
 * "blocks today" reads as a collapse in throughput rather than a clock.
 */
export function lastCompleteDay(days: readonly ChainActivityDay[]): ChainActivityDay | null {
  const sorted = [...days].sort((a, b) => b.day.localeCompare(a.day));
  return sorted[1] ?? sorted[0] ?? null;
}

export interface SurfaceRail {
  key: string;
  label: string;
  value: number | null;
  tag?: string;
  href?: string;
}

/** Per-subnet probe uptime as a rail, worst first — the reading that needs acting on. */
export function healthRail(
  subnets: readonly { netuid: number; uptime_ratio?: number | null; samples?: number }[],
  nameOf: (netuid: number) => string,
  limit = 10,
): SurfaceRail[] {
  return subnets
    .filter((subnet) => typeof subnet.uptime_ratio === "number")
    .map((subnet) => ({
      key: `sn-${subnet.netuid}`,
      label: nameOf(subnet.netuid),
      value: (subnet.uptime_ratio as number) * 100,
      href: `/subnets/${subnet.netuid}`,
    }))
    .sort((a, b) => (a.value ?? 100) - (b.value ?? 100))
    .slice(0, limit);
}
