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
//
// #10565: THE DECLARATIONS ARE READ, NOT JUST CARRIED.
//
// This module used to sum every readable source it was handed, ignoring both
// `supersedes` and `grain` -- which the registry declares correctly and which
// nothing looked at. Measured against SN64's real declarations, that produced:
//
//   window=1d  emission=$93,452
//     summed blindly     revenue=$2,334,505  coverage=2498.1%  subsidy=0.04:1
//     declarations read  revenue=$11,668     coverage=12.5%    subsidy=8.01:1
//
// The second row is the epic's own worked example. The first is what would have
// been published as fact the moment the probe lane gained a producer, and
// `verification.verified` was `true` for it -- every check was internally
// consistent while the number was 200x wrong. That is why the checks below
// assert things a wrong SUM would fail, not only things a wrong RATIO would.
import { computeCoverage, type CoverageResult } from "./revenue-coverage.ts";

/** One observed figure, for one surface, for one period. The probe lane writes
 * these to `revenue_observations` keyed on (surface_id, period). */
export interface RevenueObservation {
  surface_id: string;
  /** Verbatim from the payload: "2026-08-08", "2026-07", or SCALAR_PERIOD. */
  period: string;
  amount_usd: number;
  observed_at?: string | null;
  response_hash?: string | null;
}

export interface RevenueSourceRow {
  surface_id: string;
  provenance: string;
  currency: string;
  grain: string;
  /** Surface ids this one subsumes, from the registry declaration. */
  supersedes?: string[];
  /** The figure for the requested window, or null when one cannot be formed. */
  amount_usd: number | null;
  /** Did this surface's figure reach `revenue_usd`? Published per source so a
   * reader can see WHY a subnet with visible figures reports a null headline,
   * rather than inferring it. */
  contributes: boolean;
  /** Null when it contributed; otherwise the reason, in the response. */
  excluded_reason: string | null;
  /** How much of the window was actually observed. Published even when the
   * surface contributes, because "7 of 7 days" and "7 of 7 days but two were
   * re-observations of the same date" are different facts to a reader. */
  periods_observed?: number;
  periods_expected?: number;
  response_hash?: string | null;
  observed_at?: string | null;
}

export interface SubnetRevenueInput {
  netuid: number;
  window_days: number;
  tao_total_per_block: number;
  alpha_out_per_block?: number;
  alpha_price_tao?: number;
  /** Null when the index could not price this moment. Passed through to
   * computeCoverage, which declines every USD leg rather than zeroing it. */
  usd_per_tao: number | null;
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

/**
 * Days one period of each grain covers.
 *
 * `cumulative` is deliberately absent rather than mapped to a large number: a
 * lifetime total is not a long period, it is a running sum with no period at
 * all. Summing it into a window compares a subnet's entire history against one
 * day of emission -- the single largest term in the 2498% figure above was
 * SN64's `payments/summary/tao` `total` field, $2.3M of cumulative payments
 * added to an $11.7k daily figure. Deriving a windowed figure from it would
 * need a delta between two observations, which is a different lane.
 */
const GRAIN_DAYS: Record<string, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

/**
 * Which of a surface's observations cover the requested window, if any.
 *
 * A grain is commensurable with a window only when the window is a whole
 * number of periods: a monthly figure cannot answer "yesterday", and a weekly
 * one cannot answer a 30-day window without apportioning across a boundary --
 * which is modelling, and #10439's first hard rule forbids it.
 *
 * The window is anchored on the NEWEST observed period rather than on the
 * clock. Anchoring on `now` makes the current day a partial period whose value
 * grows all day, so a caller polling twice gets two different answers for the
 * same nominal window and neither is wrong. The trade is that a stale feed
 * reports its last complete window rather than reporting nothing -- which is
 * why `observed_at` is published per source and #10480 makes going dark an
 * event.
 */
export function windowedAmount(
  grain: string,
  windowDays: number,
  observations: RevenueObservation[],
):
  | { ok: true; amount_usd: number; observed: number; expected: number }
  | { ok: false; reason: string; observed: number; expected: number | null } {
  const grainDays = GRAIN_DAYS[grain];
  if (grainDays === undefined) {
    return {
      ok: false,
      reason: `grain "${grain}" carries no period and cannot be windowed`,
      observed: observations.length,
      expected: null,
    };
  }
  if (windowDays % grainDays !== 0) {
    return {
      ok: false,
      reason: `grain "${grain}" does not divide a ${windowDays}-day window`,
      observed: observations.length,
      expected: null,
    };
  }
  const expected = windowDays / grainDays;
  // One figure per period: the probe lane upserts on (surface_id, period), but
  // a caller may hand us anything, and summing a period twice is the same
  // double-count in miniature.
  const byPeriod = new Map<string, RevenueObservation>();
  for (const observation of observations) {
    byPeriod.set(observation.period, observation);
  }
  const newestFirst = [...byPeriod.values()].sort((a, b) =>
    b.period.localeCompare(a.period),
  );
  if (newestFirst.length < expected) {
    // A partial sum presented as a whole window UNDERSTATES, and understating
    // is not the safe direction: it is the direction that makes a subnet look
    // like it earns less than it does. Report nothing instead.
    return {
      ok: false,
      reason: `window needs ${expected} ${grain} period(s), observed ${newestFirst.length}`,
      observed: newestFirst.length,
      expected,
    };
  }
  const inWindow = newestFirst.slice(0, expected);
  return {
    ok: true,
    amount_usd: inWindow.reduce((sum, o) => sum + o.amount_usd, 0),
    observed: inWindow.length,
    expected,
  };
}

/**
 * Resolve each declared surface to a windowed figure and a contributes verdict.
 *
 * `supersedes` is honoured here rather than at the sum, so the reason travels
 * with the row. A superseded surface stays in `sources` carrying its own
 * figure -- it is real, and hiding it would make the response look like the
 * subnet publishes less than it does -- it simply never reaches the headline.
 */
export function resolveSources(
  sources: RevenueSourceRow[],
  windowDays: number,
  observationsBySurface: Map<string, RevenueObservation[]>,
): RevenueSourceRow[] {
  // Every surface subsumed by any OTHER declared surface, whether or not that
  // superseder currently carries a figure.
  //
  // Deliberately not conditional on the superseder being observed. SN64's
  // `/payments` is the TAO channel, ~10.6% of the subnet's revenue; if
  // `daily_revenue_summary` goes dark, falling back to it would report a tenth
  // of the truth as though it were the whole, which reads as a real number and
  // is worse than the null it replaces. A subset is not a total, ever.
  //
  // Keyed by the subsumed id rather than held as a bare Set so the reason can
  // name the superseder without a second lookup that would have to cope with
  // not finding one -- an unreachable branch is still a branch, and a defensive
  // fallback nobody can reach is a line asserting something that cannot happen.
  const supersededBy = new Map<string, string>();
  for (const source of sources) {
    for (const id of source.supersedes ?? []) {
      supersededBy.set(id, source.surface_id);
    }
  }

  return sources.map((source) => {
    const observations = observationsBySurface.get(source.surface_id) ?? [];
    const newest = [...observations].sort((a, b) =>
      b.period.localeCompare(a.period),
    )[0];
    const base: RevenueSourceRow = {
      ...source,
      amount_usd: null,
      contributes: false,
      excluded_reason: null,
      response_hash: newest?.response_hash ?? null,
      observed_at: newest?.observed_at ?? null,
    };

    const supersededBySurface = supersededBy.get(source.surface_id);
    if (supersededBySurface !== undefined) {
      return {
        ...base,
        excluded_reason: `superseded by ${supersededBySurface}`,
      };
    }
    if (!HEADLINE_PROVENANCES.has(source.provenance)) {
      return {
        ...base,
        excluded_reason: `provenance "${source.provenance}" is not headline-eligible`,
      };
    }
    if (observations.length === 0) {
      return { ...base, excluded_reason: "not observed" };
    }

    const windowed = windowedAmount(source.grain, windowDays, observations);
    if (!windowed.ok) {
      return {
        ...base,
        excluded_reason: windowed.reason,
        periods_observed: windowed.observed,
        ...(windowed.expected === null
          ? {}
          : { periods_expected: windowed.expected }),
      };
    }
    return {
      ...base,
      amount_usd: windowed.amount_usd,
      contributes: true,
      periods_observed: windowed.observed,
      periods_expected: windowed.expected,
    };
  });
}

export function buildSubnetRevenue(
  input: SubnetRevenueInput & {
    /** Required and explicitly nullable since #10926 -- see
     * LoadSubnetRevenueInput.observations for why the optional form was the
     * bug's hiding place. */
    observations: Map<string, RevenueObservation[]> | null;
  },
): SubnetRevenueView {
  const { searched_at = null } = input;
  const sources = resolveSources(
    input.sources,
    input.window_days,
    // No `?? new Map()`: the input is required and explicitly nullable since
    // #10926, so "nothing to pass" is a statement the caller makes rather than
    // a default that silently absorbs a forgotten argument.
    input.observations ?? new Map(),
  );

  const contributing = sources.filter((s) => s.contributes);
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

  // A check a wrong SUM fails, not only a wrong ratio. computeCoverage's three
  // are all internally consistent -- they held while the headline was 200x
  // over, because reciprocal ratios stay reciprocal no matter how wrong the
  // numerator is.
  //
  // Deliberately NOT "no superseded surface contributed" or "every contributor
  // is windowed": resolveSources decides `contributes`, so a check reading it
  // back could only ever restate that decision to itself. A check that cannot
  // fail is not verification, and those two would have passed just as happily
  // on the broken sum -- the same way `absent_revenue_is_null_not_zero` did.
  // The invariants they describe are asserted against resolveSources directly
  // in tests/revenue-serving.test.ts, which is where they CAN fail.
  //
  // This one is arithmetic over the served rows: whatever the resolution
  // decided, the published total must equal the published parts. It fires if
  // the filter and the reduce ever disagree, or if a row is mutated after
  // resolution -- and a reader can re-add the `sources` column themselves and
  // get the headline, which is the property that makes the number checkable
  // from outside.
  const partsSum = contributing.reduce(
    (sum, s) => sum + (s.amount_usd as number),
    0,
  );
  const checks: CoverageResult["verification"]["checks"] = [
    ...coverage.verification.checks,
    {
      name: "headline_is_the_sum_of_its_published_parts",
      ok:
        revenue_usd === null
          ? contributing.length === 0
          : Math.abs(partsSum - revenue_usd) < 1e-6,
      // `revenue_usd` is null exactly when nothing contributed, so the null
      // branch has one reading and does not need a nested ternary to say it.
      detail:
        revenue_usd === null
          ? `no source contributed of ${sources.length}, so there is no total to reconcile`
          : `${contributing.length} of ${sources.length} source(s) sum to ${partsSum}`,
    },
  ];

  return {
    ...coverage,
    verification: { verified: checks.every((c) => c.ok), checks },
    netuid: input.netuid,
    provenance,
    searched_at,
    sources,
  };
}
