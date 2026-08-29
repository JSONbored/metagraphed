/**
 * The derivations behind / (#11618).
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type { ChainActivityDay, SubnetEconomics, SubnetMover } from "@/lib/metagraphed/types";
import {
  formatAmount,
  formatCompact,
  formatCompactDelta,
  formatDecimal,
  formatPct,
} from "@/lib/metagraphed/format";

export type EmissionWindow = "7d" | "30d" | "90d";
export type ChainMetric = "extrinsics" | "events" | "blocks";

export const CHAIN_METRICS = [
  { value: "extrinsics", label: "Extrinsics" },
  { value: "events", label: "Events" },
  { value: "blocks", label: "Blocks" },
] as const;

/**
 * A COUNT: blocks, extrinsics, events. Whole numbers, so an integer under a
 * thousand renders bare ("812", never "812.00").
 */
export const fmtCount = (value: number | null | undefined): string => formatCompact(value);

/**
 * An AMOUNT of alpha, which is continuous rather than counted.
 *
 * Separate from `fmtCount` because the two want different sub-thousand
 * behaviour, and the emission rail used the count formatter until #11681: a
 * subnet emitting 295.2016 α rendered every one of those four decimals, in a
 * column whose other rows read "5.9k α" and "1.2k α". Three precisions in one
 * column, and the long one wrapped onto a second line.
 */
export const fmtAlpha = (value: number | null | undefined): string => formatAmount(value, "α");

/** A signed alpha change; the column header carries the unit. */
export const fmtAlphaDelta = (value: number | null | undefined): string => {
  return formatCompactDelta(value);
};

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

export interface EmissionComparisonWindow {
  window: string;
  start_date: string | null;
  end_date: string | null;
  covered_days: number | null;
  requested_days: number | null;
  window_truncated: boolean;
}

/** Plain-language provenance for the exact snapshot boundaries behind a rail. */
export function emissionComparisonNote(
  comparison: EmissionComparisonWindow | null | undefined,
  fallbackWindow: EmissionWindow,
): string {
  const range =
    comparison?.start_date && comparison.end_date
      ? `${comparison.start_date} → ${comparison.end_date}`
      : `${comparison?.window ?? fallbackWindow} comparison`;
  const coverage =
    comparison?.covered_days != null && comparison.requested_days != null
      ? `${comparison.covered_days}/${comparison.requested_days} days${comparison.window_truncated ? " (partial)" : ""}`
      : null;
  return [
    range,
    coverage,
    "bars show start-to-end daily α gains",
    "open a row for end level and network share",
    "chain-derived snapshots",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Subnets by positive emission movement over a window, with end state as detail.
 *
 * `/subnets/movers?sort=emission` is already ranked by signed emission delta.
 * Keep that meaning at the display boundary: a selected window changes the
 * gains, rather than merely reloading the same end-state allocation.
 */
export function emissionRails(
  movers: readonly SubnetMover[],
  nameOf: (netuid: number) => string,
  limit = 15,
): EmissionRail[] {
  return movers
    .filter(
      (mover) => Number.isFinite(mover.emission_delta_alpha) && mover.emission_delta_alpha > 0,
    )
    .sort((a, b) => b.emission_delta_alpha - a.emission_delta_alpha)
    .slice(0, limit)
    .map((mover) => ({
      key: String(mover.netuid),
      label: nameOf(mover.netuid),
      value: mover.emission_delta_alpha,
      href: `/subnets/${mover.netuid}`,
      detail: [
        {
          key: "end",
          label: "End daily α",
          value: fmtAlpha(mover.emission_end_alpha),
        },
        {
          key: "share",
          label: "Network share",
          value: fmtShare((mover.emission_share_pct ?? 0) / 100),
        },
        {
          key: "change",
          label: "Relative change",
          value:
            typeof mover.emission_pct_change === "number"
              ? `${mover.emission_pct_change >= 0 ? "+" : ""}${formatDecimal(mover.emission_pct_change, 1)}%`
              : "—",
        },
      ],
    }));
}

/** Chain activity days → chronological COMPLETE-day points for one measured counter. */
export function chainPoints(
  days: readonly ChainActivityDay[],
  metric: ChainMetric,
  asOfDay?: string,
): { t: number; v: number }[] {
  const pick = (day: ChainActivityDay) =>
    metric === "extrinsics"
      ? day.extrinsic_count
      : metric === "events"
        ? day.event_count
        : day.block_count;
  return completeChainDays(days, asOfDay)
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
 * Daily chain rows that are safe to compare as whole UTC days.
 *
 * The source includes the day containing its observation time, so that newest
 * row is still accumulating. Some windows also begin part-way through their
 * oldest day; only that boundary row is removed, and only when its block
 * coverage is materially below the later-day median. Interior lows remain
 * visible because they may represent real chain behavior rather than a window
 * boundary.
 */
export function completeChainDays(
  days: readonly ChainActivityDay[],
  asOfDay?: string,
): ChainActivityDay[] {
  const ordered = days
    .filter((day) => !asOfDay || day.day < asOfDay)
    .sort((a, b) => a.day.localeCompare(b.day));
  if (ordered.length < 3) return ordered;

  const oldest = ordered[0]!;
  const laterBlockCounts = ordered
    .slice(1)
    .map((day) => day.block_count)
    .filter((count) => Number.isFinite(count) && count > 0)
    .sort((a, b) => a - b);
  if (laterBlockCounts.length < 2) return ordered;
  const middle = Math.floor(laterBlockCounts.length / 2);
  const median =
    laterBlockCounts.length % 2 === 0
      ? (laterBlockCounts[middle - 1]! + laterBlockCounts[middle]!) / 2
      : laterBlockCounts[middle]!;
  return oldest.block_count < median * 0.9 ? ordered.slice(1) : ordered;
}

/**
 * The most recent COMPLETE day.
 *
 * `/chain/activity`'s newest row is the day in progress -- 1,588 blocks
 * against a full day's 7,200 when read at 05:17 UTC -- and quoting it as
 * "blocks today" reads as a collapse in throughput rather than a clock.
 */
export function lastCompleteDay(
  days: readonly ChainActivityDay[],
  asOfDay?: string,
): ChainActivityDay | null {
  const complete = completeChainDays(days, asOfDay);
  return complete[complete.length - 1] ?? null;
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
