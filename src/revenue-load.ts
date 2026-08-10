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
  buildSubnetRevenue,
  type RevenueSourceRow,
} from "./revenue-serving.ts";

// Registry/artifact rows are read for shaping only, never trusted for control
// flow. Mirrors the readJson precedent elsewhere.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

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
 * Every revenue-relevant declaration on a subnet's surfaces.
 *
 * `usage-proxy`, `miner-payout` and `not-revenue` surfaces are deliberately
 * EXCLUDED. They are real verdicts and worth recording in the registry, but a
 * revenue response listing SN4's `payout` field among its "sources" invites
 * exactly the reading the role vocabulary exists to prevent.
 */
export function revenueSourcesFor(
  surfaces: Row[] | null | undefined,
  observationsBySurface: Map<
    string,
    { amount_usd: number; response_hash?: string; observed_at?: string }
  > = new Map(),
): RevenueSourceRow[] {
  const out: RevenueSourceRow[] = [];
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    const revenue = surface?.revenue as Row | undefined;
    if (!revenue || revenue.role !== "external-revenue") continue;
    const observed = observationsBySurface.get(String(surface.id));
    out.push({
      surface_id: String(surface.id),
      provenance: String(revenue.provenance ?? "none"),
      currency: String(revenue.currency ?? "USD"),
      grain: String(revenue.grain ?? "cumulative"),
      amount_usd: observed ? observed.amount_usd : null,
      response_hash: observed?.response_hash ?? null,
      observed_at: observed?.observed_at ?? null,
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
  observations?: Map<
    string,
    { amount_usd: number; response_hash?: string; observed_at?: string }
  >;
}

/** Compose the served body. Never throws on missing pieces. */
export function loadSubnetRevenue(input: LoadSubnetRevenueInput): Row {
  const sources = revenueSourcesFor(input.surfaces, input.observations);
  const view = buildSubnetRevenue({
    netuid: input.netuid,
    window_days: input.window_days,
    tao_total_per_block: taoTotalPerBlock(input.economics),
    alpha_out_per_block: num(input.economics?.alpha_out_emission),
    alpha_price_tao: num(input.economics?.alpha_price_tao),
    // A missing price prices the emission at 0 USD, which computeCoverage then
    // turns into null ratios -- the same output as unobserved revenue, and the
    // honest one: without a rate there is no USD comparison to make.
    usd_per_tao: input.usd_per_tao ?? 0,
    sources,
    searched_at: input.searched_at ?? null,
  });
  return view;
}
