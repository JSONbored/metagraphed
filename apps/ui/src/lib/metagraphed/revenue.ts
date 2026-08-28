import { formatDecimal, formatPct } from "./format";
import type { RevenueProvenance, RevenueSource, RevenueWindow, SubnetRevenue } from "./types";

/** The only aggregation windows the served revenue contract supports. */
export const REVENUE_WINDOW_OPTIONS = [
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const satisfies ReadonlyArray<{ value: RevenueWindow; label: string }>;

/** A real 0 is observed; only null means the evidence is absent. */
export function hasObservedRevenue(
  revenue: Pick<SubnetRevenue, "revenue_usd"> | null | undefined,
): boolean {
  return revenue?.revenue_usd != null;
}

/** Whether a reported value is safe to render as the response's headline. */
export function revenueHeadlineState(
  revenue: Pick<SubnetRevenue, "revenue_usd" | "provenance" | "verification"> | null | undefined,
): "verified" | "not-observed" | "not-verified" | "unavailable" {
  if (!revenue) return "unavailable";
  if (!hasObservedRevenue(revenue)) {
    // Only the explicit, validated `none` state is an affirmative observation
    // that revenue was not found. A malformed or partial response is merely
    // unavailable, never evidence of zero external demand.
    return revenue.provenance === "none" && revenue.verification.verified === true
      ? "not-observed"
      : "unavailable";
  }
  return revenue.verification.verified === true ? "verified" : "not-verified";
}

/** Human-readable labels for the contract's evidence vocabulary. */
export function revenueProvenanceLabel(provenance: RevenueProvenance | null): string {
  switch (provenance) {
    case "chain-verified":
      return "Chain verified";
    case "probe-derived":
      return "Probe derived";
    case "operator-attested":
      return "Operator attested";
    case "third-party-reported":
      return "Third-party reported";
    case "proxy-only":
      return "Proxy only";
    case "none":
      return "Not observed";
    default:
      return "Evidence unavailable";
  }
}

/** The source-level inclusion state, without treating missing data as false. */
export function revenueSourceStatus(source: Pick<RevenueSource, "contributes">): string {
  if (source.contributes === true) return "Included";
  if (source.contributes === false) return "Excluded";
  return "Unknown";
}

/** The interval coverage that makes a source amount representative of its window. */
export function revenueSourcePeriods(
  source: Pick<RevenueSource, "periods_observed" | "periods_expected">,
): string {
  if (source.periods_observed == null && source.periods_expected == null) return "—";
  if (source.periods_observed != null && source.periods_expected != null) {
    return `${source.periods_observed} / ${source.periods_expected}`;
  }
  if (source.periods_observed != null) return `${source.periods_observed} observed`;
  return `${source.periods_expected} expected`;
}

/** A missing multiple is not infinity: it is not applicable to absent/zero revenue. */
export function subsidyMultipleLabel(value: number | null | undefined): string {
  return value == null ? "Not applicable" : `${formatDecimal(value, 1)}×`;
}

/** How much of the directory has a readable revenue figure, not revenue coverage. */
export function directoryEvidenceCoverage(
  observedCount: number | null | undefined,
  subnetCount: number | null | undefined,
): string {
  if (observedCount == null || subnetCount == null || subnetCount <= 0) return "—";
  return formatPct(observedCount / subnetCount, 1);
}

export function revenueWindowLabel(
  revenue: Pick<SubnetRevenue, "window_days"> | null | undefined,
  fallback: RevenueWindow,
): string {
  return revenue?.window_days != null ? `${revenue.window_days}d` : fallback;
}

/**
 * A concise honest footnote for the subnet evidence ledger. It deliberately
 * says "observed" rather than pretending an absent source is a zero value.
 */
export function revenueEvidenceFootnote(
  revenue: SubnetRevenue,
  fallbackWindow: RevenueWindow,
): string {
  const window = revenueWindowLabel(revenue, fallbackWindow);
  const state = revenueHeadlineState(revenue);
  if (state === "not-observed") {
    return `${window} · no readable external revenue observed · emitted TAO is the comparison baseline`;
  }
  if (state === "not-verified") {
    return `${window} · revenue was reported but has not passed response validation`;
  }
  if (state === "unavailable") {
    return `${window} · revenue evidence did not arrive in a complete, validated form`;
  }
  const included = revenue.sources.filter((source) => source.contributes === true).length;
  const sourceLabel = `${included} included source${included === 1 ? "" : "s"}`;
  return `${window} · ${sourceLabel} · ${revenueProvenanceLabel(revenue.provenance)}`;
}
