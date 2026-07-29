// Route-family cost weights for quota accounting (#8608).
//
// A daily quota that counts every request as 1 prices a cached artifact read
// the same as a deep-history Postgres scan or an LLM call, which ADR 0022
// identifies as the central flaw in a flat-multiplier model:
//
//   "the routes people would most want a paid tier FOR (deep-history, bulk
//    archive) are exactly the routes with the least Cloudflare-metered, most
//    infrastructure-capacity-bound cost shape — a flat-rate-limit-multiplier
//    model prices every route the same even though their actual cost profiles
//    are wildly different."
//
// So a quota unit is a COST unit, not a request. The families and their
// ordering come straight from ADR 0022's four documented cost shapes; only the
// magnitudes are ours, and they are deliberately small integers rather than
// false precision.
//
// #8597 is the issue that will make real per-family cost queryable. Until it
// lands there is no measured $/request to derive these from — ADR 0022 marks
// every dollar figure 🔶 for exactly that reason. These weights therefore
// encode the SHAPE ADR 0022 establishes (which family is dearer than which,
// and roughly by how much), not a costing. Retune the numbers when #8597
// produces data; the shape is unlikely to move.
export const DEFAULT_ROUTE_COST_WEIGHT = 1;

export interface RouteCostFamily {
  /** ADR 0022 cost-shape name. */
  family: string;
  weight: number;
  /**
   * Matched against the request pathname, in order.
   *
   * Families end at a PATH-SEGMENT boundary -- `(?=[/?]|$)`, not `\b`. `\b`
   * treats a hyphen as a boundary, so `/subnets/18/lease-terms` matched the
   * `lease` family and would have been billed 5 units as a deep-history scan.
   * Any hyphenated sibling of a listed route had the same problem.
   */
  test: RegExp;
}

export const ROUTE_COST_WEIGHTS: RouteCostFamily[] = [
  {
    // "the one route family with a real, immediate per-call cost" — already
    // carries the tightest limiter in the codebase (AI_RATE_LIMITER, 20/60s).
    family: "ai",
    weight: 25,
    test: /^\/(api\/v1\/)?(ask|search\/semantic)(?=[/?]|$)/,
  },
  {
    // "storage + egress, the one tier with genuine bandwidth cost… the closest
    // thing this platform has to a caller who costs real, scaling money."
    family: "archive",
    weight: 10,
    test: /^\/(datasets|metagraph\/history)(?=[/?]|$)/,
  },
  {
    // "fixed capacity, not per-request billed… the real cost of a heavy caller
    // here isn't '$X per request' — it's connection-pool contention crowding
    // out other callers." Exactly the families #8386 tiered first.
    family: "deep-history",
    weight: 5,
    test: /^\/api\/v1\/(chain-events|accounts\/[^/]+\/(events|history|transfers|positions)|subnets\/\d+\/(ownership-history|conviction|lease)|extrinsics|blocks)(?=[/?]|$)/,
  },
  {
    // "metered, near-zero marginal… a cache hit costs a fraction of a cent
    // regardless of who's asking." The default, and the overwhelming majority.
    family: "edge",
    weight: DEFAULT_ROUTE_COST_WEIGHT,
    test: /^\//,
  },
];

/** The cost family a pathname belongs to, and what one call against it spends. */
export function routeCost(pathname: string): {
  family: string;
  weight: number;
} {
  for (const entry of ROUTE_COST_WEIGHTS) {
    if (entry.test.test(pathname)) {
      return { family: entry.family, weight: entry.weight };
    }
  }
  return { family: "edge", weight: DEFAULT_ROUTE_COST_WEIGHT };
}
