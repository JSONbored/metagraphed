// #10447: read what a subnet DECLARES about its revenue, and price it against
// what the network emits to it.
//
// Everything here is a projection over data that already exists: the surfaces
// carry the declarations (#10441), the economics capture carries the emission
// denominator, and src/revenue-serving.ts decides which declarations may
// contribute a number. The only new judgement is what to do when a piece is
// missing, and the answer is always the same -- say so, in the shape the caller
// already expects.
//
// A subnet with no revenue data must not 404 and must not 500. 127 of 129 are
// in that state; an error there would make the normal case look like a broken
// endpoint, and a caller sweeping the network would see 127 failures instead of
// 127 answers.
import {
  type SubnetRevenueView,
  buildSubnetRevenue,
  type RevenueObservation,
  type RevenueSourceRow,
} from "./revenue-serving.ts";

// Registry/artifact rows are read for shaping only, never trusted for control
// flow. Mirrors the readJson precedent elsewhere.
type Row = Record<string, unknown>;

export const SUBNET_REVENUE_FIELD_SOURCES = {
  "emission.tao": {
    kind: "measured",
    storage:
      "SubtensorModule.SubnetTaoInEmission + SubtensorModule.SubnetExcessTao",
  },
  "emission.usd": { kind: "reconstructed", storage: null },
  "emission.alternates.alpha_out_priced": {
    kind: "reconstructed",
    storage: null,
  },
  "emission.alternates.owner_take": { kind: "reconstructed", storage: null },
  revenue_usd: { kind: "measured", storage: null },
  coverage_ratio: { kind: "reconstructed", storage: null },
  subsidy_multiple: { kind: "reconstructed", storage: null },
} as const;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * The per-block TAO a subnet receives: the two emission channels summed.
 *
 * Returns 0 rather than null when neither channel is present. An emission-gated
 * subnet genuinely receives nothing, and computeCoverage turns a zero
 * denominator into null ratios rather than into Infinity -- so the "no data"
 * and "gated" cases converge on the same honest output without this function
 * having to distinguish them.
 */
export function taoTotalPerBlock(economics: Row | null): number {
  return (
    (num(economics?.tao_in_emission_tao) ?? 0) +
    (num(economics?.excess_tao) ?? 0)
  );
}

/**
 * Every revenue-relevant DECLARATION on a subnet's surfaces.
 *
 * `usage-proxy`, `miner-payout` and `not-revenue` surfaces are deliberately
 * EXCLUDED. They are real verdicts and worth recording in the registry, but a
 * revenue response listing SN4's `payout` field among its "sources" invites
 * exactly the reading the role vocabulary exists to prevent.
 *
 * #10565: declarations ONLY -- no figures. This used to take an observation map
 * and stamp one scalar `amount_usd` per surface, which is the shape that made
 * the window unrepresentable: one number per surface cannot answer "the last 7
 * days" for a daily feed. Resolving a declaration against its observation
 * series is src/revenue-serving.ts's job, because that is where the grain and
 * `supersedes` rules live.
 */
export function revenueSourcesFor(
  surfaces: Row[] | null | undefined,
): RevenueSourceRow[] {
  const out: RevenueSourceRow[] = [];
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    const revenue = surface?.revenue as Row | undefined;
    if (!revenue || revenue.role !== "external-revenue") continue;
    out.push({
      surface_id: String(surface.id),
      provenance: String(revenue.provenance ?? "none"),
      currency: String(revenue.currency ?? "USD"),
      grain: String(revenue.grain ?? "cumulative"),
      // Carried through, not just declared. The registry has said since #10441
      // that SN64's daily_revenue_summary subsumes both payment surfaces; the
      // composition layer never read it, and summing the subsets put the
      // headline 200x over (#10565).
      supersedes: Array.isArray(revenue.supersedes)
        ? revenue.supersedes.map(String)
        : undefined,
      amount_usd: null,
      contributes: false,
      excluded_reason: null,
    });
  }
  return out;
}

export interface LoadSubnetRevenueInput {
  netuid: number;
  window_days: number;
  economics: Row | null;
  surfaces: Row[] | null;
  usd_per_tao: number | null;
  searched_at?: string | null;
  /** The observation SERIES per surface, newest period in any order. */
  observations?: Map<string, RevenueObservation[]>;
}

/** Compose the served body. Never throws on missing pieces. */
// Returns the VIEW it builds, not a row bag. It always did; the declaration
// said otherwise, and `Row` as `Record<string, any>` let both readings stand
// (#10782).
export function loadSubnetRevenue(
  input: LoadSubnetRevenueInput,
): SubnetRevenueView {
  const sources = revenueSourcesFor(input.surfaces);
  const view = buildSubnetRevenue({
    netuid: input.netuid,
    window_days: input.window_days,
    tao_total_per_block: taoTotalPerBlock(input.economics),
    alpha_out_per_block: num(input.economics?.alpha_out_emission),
    alpha_price_tao: num(input.economics?.alpha_price_tao),
    // NOT `?? 0`. Coalescing here priced every subnet's emission at
    // literally zero USD -- the ratios did come out null as intended, but
    // `emission.usd` and both `alternates` branches published a hard 0 beside a
    // real `emission.tao`. A missing rate travels as null the whole way down,
    // and computeCoverage declines every USD leg together.
    usd_per_tao: input.usd_per_tao,
    sources,
    observations: input.observations,
    searched_at: input.searched_at ?? null,
  });
  return view;
}
