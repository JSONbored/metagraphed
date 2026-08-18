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
  DEFAULT_SUBNET_REVENUE_WINDOW,
  SUBNET_REVENUE_WINDOW_DAYS,
} from "./route-limits.ts";
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
/** The one published artifact carrying every subnet's surfaces. */
export const ALL_SURFACES_ARTIFACT = "/metagraph/surfaces.json";

/**
 * Every subnet's surfaces, grouped by netuid, from the ONE artifact that
 * carries all of them.
 *
 * ## Why one read replaces a hundred and twenty-nine
 *
 * The three surfaces composing network-wide revenue each read
 * `/metagraph/subnets/{netuid}.json` per subnet. #11477 and #11478 made those
 * reads concurrent, taking REST from 14.4s to 1.7s and GraphQL from 7.5s to
 * 1.0s -- but 129 reads of a ~271 KB artifact is ~35 MB per request however it
 * is scheduled, and that is the floor those changes hit. `surfaces.json` is
 * 3.5 MB and carries the same surfaces.
 *
 * ## Why substituting it is safe -- which #11478 argued the opposite of
 *
 * That PR declined this on the grounds it "would make this route's correctness
 * depend on the bulk artifact agreeing with the per-subnet ones". Measured,
 * they cannot disagree: `surfaces.json`, `subnets/64.json` and
 * `economics.json` all carry the SAME `generated_at`
 * (2026-08-14T12:14:17.177Z), because one build publishes all of them. There is
 * no window in which one is newer than another.
 *
 * And they agree where it counts. All ten `external-revenue` surfaces across
 * the five subnets that declare them (51, 64, 75, 93, 110) match field for
 * field between the two sources -- `revenue`, `url`, `source_urls`, `kind`,
 * `id`, `netuid` -- verified 2026-08-18. `loadSubnetRevenue` consumes
 * `surfaces` through `revenueSourcesFor` and nothing else, so those are the
 * fields that decide the answer.
 *
 * GROUPED WHOLE, not filtered to revenue surfaces. Returning every surface for
 * a netuid keeps this exactly what the per-subnet read returned, so a future
 * change to what `revenueSourcesFor` looks for cannot quietly outgrow it.
 */
export function groupSurfacesByNetuid(
  all: Row[] | null | undefined,
): Map<number, Row[]> {
  const out = new Map<number, Row[]>();
  for (const surface of Array.isArray(all) ? all : []) {
    const raw = (surface as Row | undefined)?.netuid;
    // `typeof raw === "number"` BEFORE the integer check, because `Number(null)`
    // is 0 and `Number("")` is 0 -- a surface with a null netuid would be filed
    // under subnet ZERO, which exists. The per-subnet read this replaces could
    // not reach that case: the netuid was the path it fetched, so an unusable
    // one produced no artifact rather than a wrong bucket. Reading them out of
    // one artifact makes the value reachable, so it has to be checked.
    if (typeof raw !== "number" || !Number.isInteger(raw)) continue;
    const netuid = raw;
    const bucket = out.get(netuid);
    if (bucket) bucket.push(surface);
    else out.set(netuid, [surface]);
  }
  return out;
}

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
  /**
   * The observation SERIES per surface, newest period in any order.
   *
   * REQUIRED, and explicitly nullable, since #10926. It was
   * `observations?:` with `?? new Map()` downstream, and that default was the
   * bug's hiding place: three MCP tools simply never passed it, so every
   * source reported `excluded_reason: "not observed"` and `revenue_usd` was
   * null for every subnet forever -- a correct-looking decline standing in for
   * a read that never happened, invisible because the decline is the
   * documented normal answer.
   *
   * A caller with genuinely nothing to pass now has to SAY so (`observations:
   * null`), which is a sentence somebody can read and check. Omission is a
   * compile error.
   */
  observations: Map<string, RevenueObservation[]> | null;
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

/**
 * The window a revenue caller asked for, in DAYS.
 *
 * Lives beside the loader every surface calls, so REST, MCP and GraphQL cannot
 * resolve the same `?window=` to different denominators -- which is the exact
 * failure the hardcoded `1` was hiding at nine sites. An unrecognised value
 * falls back to the default rather than throwing: the router, the MCP input
 * schema and the GraphQL dispatch have all already rejected anything outside
 * the published enum by the time this runs, so a throw here would be
 * unreachable, and a silent default is the safer unreachable branch.
 */
export function revenueWindowDays(window: unknown): number {
  const label =
    typeof window === "string" && window
      ? window
      : DEFAULT_SUBNET_REVENUE_WINDOW;
  return (
    SUBNET_REVENUE_WINDOW_DAYS[label] ??
    SUBNET_REVENUE_WINDOW_DAYS[DEFAULT_SUBNET_REVENUE_WINDOW]
  );
}
