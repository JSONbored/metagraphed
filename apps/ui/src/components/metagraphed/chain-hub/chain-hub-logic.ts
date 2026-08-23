/**
 * The derivations behind /chain (#11619).
 */
import { RESIDUAL_KEY } from "@jsonbored/ui-kit";
import type {
  ChainCallEntry,
  ChainFeeDay,
  ChainStakeFlowSubnet,
  Extrinsic,
  RuntimeTransition,
} from "@/lib/metagraphed/types";
import { formatAmountFixed, formatCompact, formatPct } from "@/lib/metagraphed/format";

export type ChainWindowValue = "7d" | "30d";

export const CHAIN_WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

export const FEE_WINDOWS = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const;

export const fmtCount = (value: number | null | undefined): string => formatCompact(value);

export const fmtTao = (value: number | null | undefined, places = 2): string =>
  formatAmountFixed(value, places);

export const fmtShare = (fraction: number | null | undefined, places = 1): string =>
  formatPct(fraction, places);

export interface CallSegment {
  key: string;
  label: string;
  value: number;
}

/**
 * Extrinsics by call module as a composition of the window.
 *
 * `/chain/calls` publishes per-module TOTALS for the window and no hourly
 * series, so this is what the chain did over the window rather than when it
 * did it. The window control changes the period the composition covers.
 */
export function callSegments(calls: readonly ChainCallEntry[], top = 8): CallSegment[] {
  const ranked = calls
    .filter((call) => (call.count ?? 0) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const head = ranked.slice(0, top).map((call) => ({
    key: call.call_module ?? "unknown",
    label: call.call_module ?? "unknown",
    value: call.count ?? 0,
  }));
  const tail = ranked.slice(top);
  if (tail.length > 0) {
    head.push({
      key: RESIDUAL_KEY,
      label: `${tail.length} more modules`,
      value: tail.reduce((acc, call) => acc + (call.count ?? 0), 0),
    });
  }
  return head;
}

/** Daily fee totals → chronological line points. */
export function feePoints(days: readonly ChainFeeDay[]): { t: number; v: number }[] {
  return days
    .map((day) => {
      const t = Date.parse(`${day.day}T00:00:00Z`);
      const v = day.total_fee_tao;
      return typeof v === "number" && Number.isFinite(v) && Number.isFinite(t) ? { t, v } : null;
    })
    .filter((point): point is { t: number; v: number } => point !== null)
    .sort((a, b) => a.t - b.t);
}

export interface FlowColumn {
  key: string;
  label: string;
  axisLabel: string;
  total: number;
  segments: { key: string; label: string; value: number }[];
}

/**
 * Stake movement per subnet over the window, busiest first.
 *
 * Both directions on every column: a subnet that only saw exits still shows
 * the bar that says so, and a net-only view would render it as a small
 * negative indistinguishable from a quiet one.
 */
export function flowColumns(
  subnets: readonly ChainStakeFlowSubnet[],
  nameOf: (netuid: number) => string,
  top = 12,
): FlowColumn[] {
  return subnets
    .map((subnet) => {
      const staked = typeof subnet.total_staked_tao === "number" ? subnet.total_staked_tao : 0;
      const unstaked =
        typeof subnet.total_unstaked_tao === "number" ? subnet.total_unstaked_tao : 0;
      return {
        key: `sn-${subnet.netuid}`,
        label: nameOf(subnet.netuid),
        axisLabel: `SN${subnet.netuid}`,
        total: staked + unstaked,
        segments: [
          { key: "staked", label: "Staked in", value: staked },
          { key: "unstaked", label: "Unstaked out", value: unstaked },
        ],
      };
    })
    .filter((column) => column.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, top);
}

export interface GovernanceRow {
  key: string;
  kind: string;
  block: number | null;
  at: string | null;
  summary: string;
  signer: string | null;
}

/**
 * Runtime upgrades, sudo calls and config changes as one stream.
 *
 * They were three routes and three tables answering one question -- what
 * changed about how the chain runs -- and a reader had to know which of the
 * three a change would have landed in. `kind` is the filter that used to be
 * the navigation.
 */
export function governanceRows(
  runtime: readonly RuntimeTransition[],
  sudo: readonly Extrinsic[],
  config: readonly Extrinsic[],
): GovernanceRow[] {
  const rows: GovernanceRow[] = [];
  for (const transition of runtime) {
    rows.push({
      key: `runtime-${transition.spec_version}`,
      kind: "runtime upgrade",
      block: transition.block_number ?? null,
      at: transition.observed_at ?? null,
      summary: `spec ${transition.spec_version}`,
      signer: null,
    });
  }
  for (const [list, kind] of [
    [sudo, "sudo"],
    [config, "config change"],
  ] as const) {
    for (const extrinsic of list) {
      rows.push({
        key: `${kind}-${extrinsic.block_number}-${extrinsic.extrinsic_index}`,
        kind,
        block: extrinsic.block_number ?? null,
        at: extrinsic.observed_at ?? null,
        summary: [extrinsic.call_module, extrinsic.call_function].filter(Boolean).join(".") || kind,
        signer: extrinsic.signer ?? null,
      });
    }
  }
  return rows.sort((a, b) => (b.block ?? 0) - (a.block ?? 0));
}

export interface PipelineRail {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}

/**
 * Subnets by the share of emission they ACTUALLY receive, with each stage of
 * the pipeline that produced it in the tooltip.
 *
 * `final_share`, not `emission_share`: the first is what the subnet is paid
 * and the second is what it would be paid before the gate. Ranking by the
 * pre-gate figure would put a disabled subnet above a paid one -- which is
 * the whole thing the emission gate does, stated backwards.
 */
export function pipelineRails(
  subnets: readonly {
    netuid: number;
    emission_share: number | null;
    weighted_share: number | null;
    gated_share: number | null;
    final_share: number | null;
    gate_delta: number | null;
    emission_enabled: boolean;
    ineligible_reason: string | null;
  }[],
  nameOf: (netuid: number) => string,
  limit = 15,
): PipelineRail[] {
  return subnets
    .filter((subnet) => typeof subnet.final_share === "number" && subnet.final_share > 0)
    .sort((a, b) => (b.final_share ?? 0) - (a.final_share ?? 0))
    .slice(0, limit)
    .map((subnet) => ({
      key: `sn-${subnet.netuid}`,
      label: nameOf(subnet.netuid),
      value: subnet.final_share ?? 0,
      href: `/subnets/${subnet.netuid}`,
      detail: [
        { key: "raw", label: "Published share", value: fmtShare(subnet.emission_share, 3) },
        { key: "weighted", label: "After weighting", value: fmtShare(subnet.weighted_share, 3) },
        { key: "gated", label: "After the gate", value: fmtShare(subnet.gated_share, 3) },
        {
          key: "delta",
          label: "Gate gave/took",
          value:
            typeof subnet.gate_delta === "number"
              ? `${subnet.gate_delta >= 0 ? "+" : ""}${formatPct(subnet.gate_delta, 3)}`
              : "—",
        },
      ],
    }));
}

export interface PipelineTally {
  total: number;
  paid: number;
  unpaid: number;
  ineligible: number;
  disabled: number;
  zeroWeighted: number;
}

/**
 * How many subnets are actually paid, and the three separate ways the rest
 * end up at nothing.
 *
 * Counted off the rows rather than read off the response's `aggregate`, whose
 * `eligible_count` (126) and `disabled_count` (37) are two nested figures --
 * disabled is a SUBSET of eligible, not its complement -- so a strip that put
 * them side by side would read as 126 of 163, and 163 is not the count of
 * anything. The rows carry the same numbers unambiguously.
 *
 * `weighted_share === 0` on a subnet with a published `emission_share` is the
 * third route to nothing and the least visible one: 11 subnets publish a share
 * and are zeroed by the weighting before the gate ever sees them.
 */
export function pipelineTally(
  subnets: readonly {
    ineligible_reason: string | null;
    emission_enabled: boolean;
    final_share: number | null;
  }[],
): PipelineTally {
  const paid = subnets.filter((s) => (s.final_share ?? 0) > 0).length;
  const ineligible = subnets.filter((s) => s.ineligible_reason !== null).length;
  const eligible = subnets.filter((s) => s.ineligible_reason === null);
  const disabled = eligible.filter((s) => !s.emission_enabled).length;
  return {
    total: subnets.length,
    paid,
    unpaid: subnets.length - paid,
    ineligible,
    disabled,
    zeroWeighted: subnets.length - paid - ineligible - disabled,
  };
}

/**
 * The most recent COMPLETE day.
 *
 * `/chain/activity`'s newest row is the day in progress, so quoting it in a
 * headline strip reads as a collapse in throughput rather than a clock.
 */
export function lastCompleteDay<T extends { day: string }>(days: readonly T[]): T | null {
  const sorted = [...days].sort((a, b) => b.day.localeCompare(a.day));
  return sorted[1] ?? sorted[0] ?? null;
}

/** The distinct kinds present, for the governance filter. */
export function governanceKinds(rows: readonly GovernanceRow[]): string[] {
  return [...new Set(rows.map((row) => row.kind))].sort();
}
