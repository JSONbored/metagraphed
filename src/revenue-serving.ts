// #10447: compose the served revenue shape from the pieces that already exist.
//
// The emission denominator comes from the economics capture, the revenue from
// the probe lane's observations, the price from the tao-usd index, and the
// arithmetic from src/revenue-coverage.ts. Nothing is computed twice.
//
// The degradation rule is the whole point of this module. The observations
// table is new and empty, most subnets will never have a row in it, and an
// operator can withdraw a feed at any time. Every one of those reads back as
// `revenue_usd: null` with a stated provenance -- NOT as zero, and not as an
// error. A 500 here would make "we have no revenue data for this subnet", which
// is true of 127 of 129, look like a broken endpoint.
import { computeCoverage, type CoverageResult } from "./revenue-coverage.ts";

export interface RevenueSourceRow {
  surface_id: string;
  provenance: string;
  currency: string;
  grain: string;
  amount_usd: number | null;
  response_hash?: string | null;
  observed_at?: string | null;
}

export interface SubnetRevenueInput {
  netuid: number;
  window_days: number;
  tao_total_per_block: number;
  alpha_out_per_block?: number;
  alpha_price_tao?: number;
  usd_per_tao: number;
  /** Every declared revenue surface for this subnet, readable or not. */
  sources: RevenueSourceRow[];
  /** When the subnet was searched and nothing found (#10543). */
  searched_at?: string | null;
}

export interface SubnetRevenueView extends CoverageResult {
  netuid: number;
  provenance: string;
  searched_at: string | null;
  sources: RevenueSourceRow[];
}

/** Only these contribute to the headline. #10439's ladder, enforced in code
 * rather than left to whoever assembles the sum. */
const HEADLINE_PROVENANCES = new Set(["chain-verified", "probe-derived"]);

/** Most specific wins: a chain-corroborated figure outranks a probed one,
 * which outranks an operator's claim. Reported as the response's single
 * `provenance` so a caller never has to rank them itself. */
const PROVENANCE_RANK = [
  "chain-verified",
  "probe-derived",
  "operator-attested",
  "third-party-reported",
  "proxy-only",
  "none",
];

export function buildSubnetRevenue(
  input: SubnetRevenueInput,
): SubnetRevenueView {
  const { sources, searched_at = null } = input;

  // Sum ONLY the readable tiers, and only rows that actually carry a figure.
  // An operator-attested surface is real and is reported in `sources`; adding
  // it here would put an unverifiable number in the headline.
  const contributing = sources.filter(
    (s) => HEADLINE_PROVENANCES.has(s.provenance) && s.amount_usd !== null,
  );
  const revenue_usd = contributing.length
    ? contributing.reduce((sum, s) => sum + (s.amount_usd as number), 0)
    : null;

  const coverage = computeCoverage({
    tao_total_per_block: input.tao_total_per_block,
    alpha_out_per_block: input.alpha_out_per_block,
    alpha_price_tao: input.alpha_price_tao,
    usd_per_tao: input.usd_per_tao,
    window_days: input.window_days,
    revenue_usd,
  });

  // The best evidence class present, so the response carries one answer rather
  // than making every caller rank the list itself.
  let provenance = "none";
  for (const candidate of PROVENANCE_RANK) {
    if (sources.some((s) => s.provenance === candidate)) {
      provenance = candidate;
      break;
    }
  }

  return {
    ...coverage,
    netuid: input.netuid,
    provenance,
    searched_at,
    sources,
  };
}
