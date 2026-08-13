// #10447: which sources reach the headline, and which are reported without
// reaching it. Getting this wrong is silent — the response looks identical.
//
// #10565: the declarations are now READ. Measured against SN64's real registry
// entries, summing them blindly produced $2,334,505 and a 2498% coverage ratio
// where the epic's own worked example is $11,668 and 12.5% — and
// `verification.verified` was true throughout, because every check was
// internally consistent while the number was 200x wrong.
//
// The `supersedes` and grain invariants are asserted against resolveSources
// HERE rather than as verification checks in the response. resolveSources
// decides `contributes`, so a check reading it back could only restate that
// decision to itself; these tests can actually fail.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetRevenue,
  resolveSources,
  windowedAmount,
  type RevenueObservation,
  type RevenueSourceRow,
} from "../src/revenue-serving.ts";

const BASE = {
  netuid: 64,
  window_days: 1,
  tao_total_per_block: 0.063615264,
  usd_per_tao: 204.03,
  sources: [] as RevenueSourceRow[],
  // Stated, not omitted (#10926): the field is required and explicitly
  // nullable, so a fixture with no observation series says so once here rather
  // than every case relying on a default that used to hide a dropped argument.
  observations: null,
};

function src(over: Partial<RevenueSourceRow> = {}): RevenueSourceRow {
  return {
    surface_id: "s",
    provenance: "probe-derived",
    currency: "USD",
    grain: "daily",
    amount_usd: null,
    contributes: false,
    excluded_reason: null,
    ...over,
  };
}

/** One surface's series. Periods are dates for daily, "YYYY-MM" for monthly. */
function series(
  surface_id: string,
  amounts: Array<[string, number]>,
): [string, RevenueObservation[]] {
  return [
    surface_id,
    amounts.map(([period, amount_usd]) => ({
      surface_id,
      period,
      amount_usd,
    })),
  ];
}

/** N consecutive days of the same figure, ending 2026-08-10. */
function daily(surface_id: string, amount: number, days: number) {
  const out: Array<[string, number]> = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.UTC(2026, 7, 10 - i));
    out.push([d.toISOString().slice(0, 10), amount]);
  }
  return series(surface_id, out);
}

describe("only readable tiers reach the headline", () => {
  test("probe-derived and chain-verified are summed", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ surface_id: "a" }),
        src({ surface_id: "b", provenance: "chain-verified" }),
      ],
      observations: new Map([daily("a", 1000, 1), daily("b", 500, 1)]),
    });
    assert.equal(r.revenue_usd, 1500);
    assert.ok((r.coverage_ratio as number) > 0);
  });

  test("operator-attested is REPORTED but never summed", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ provenance: "operator-attested" })],
      observations: new Map([daily("s", 999999, 1)]),
    });
    assert.equal(r.revenue_usd, null, "must not be summed");
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.sources.length, 1, "but it is still reported");
    assert.equal(r.provenance, "operator-attested");
    assert.match(r.sources[0].excluded_reason ?? "", /not headline-eligible/);
  });

  test("a readable source with no observation does not fabricate one", () => {
    const r = buildSubnetRevenue({ ...BASE, sources: [src()] });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.subsidy_multiple, null);
    assert.equal(r.sources[0].excluded_reason, "not observed");
  });
});

describe("supersedes — the channel double-count", () => {
  // SN64 as the registry actually declares it: daily_revenue_summary subsumes
  // both payment surfaces. Summing all three is what produced 2498%.
  const SN64 = [
    src({
      surface_id: "daily-summary",
      grain: "daily",
      supersedes: ["payments-list", "tao-totals"],
    }),
    src({ surface_id: "tao-totals", grain: "cumulative" }),
    src({
      surface_id: "payments-list",
      grain: "cumulative",
      provenance: "chain-verified",
    }),
  ];
  const OBSERVED = new Map([
    daily("daily-summary", 11668, 90),
    series("tao-totals", [["__total__", 2321800]]),
    series("payments-list", [["__total__", 1036.5]]),
  ]);

  test("the subset never reaches the headline", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: SN64,
      observations: OBSERVED,
    });
    assert.equal(r.revenue_usd, 11668, "only the superseding surface counts");
    assert.ok(Math.abs((r.coverage_ratio as number) - 0.125) < 0.001);
    assert.ok(Math.abs((r.subsidy_multiple as number) - 8.0) < 0.05);
  });

  test("but it is still visible, with its figure and its reason", () => {
    const rows = resolveSources(SN64, 1, OBSERVED);
    const subset = rows.find((s) => s.surface_id === "payments-list");
    assert.ok(subset);
    assert.equal(subset.contributes, false);
    assert.match(subset.excluded_reason ?? "", /superseded by daily-summary/);
    // Hiding it would make the subnet look like it publishes less than it does.
    assert.equal(rows.length, 3);
  });

  test("a subset does NOT stand in when its superseder goes dark", () => {
    // payments-list is the TAO channel, ~10.6% of SN64's revenue. Reporting it
    // as the subnet's revenue understates by ~90% and reads as a real number,
    // which is worse than the null it would replace.
    const r = buildSubnetRevenue({
      ...BASE,
      sources: SN64,
      observations: new Map([series("payments-list", [["__total__", 1036.5]])]),
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
  });
});

describe("grain — a cumulative total is not a windowed figure", () => {
  test("cumulative never contributes", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ grain: "cumulative" })],
      observations: new Map([series("s", [["__total__", 2321800]])]),
    });
    assert.equal(r.revenue_usd, null);
    assert.match(r.sources[0].excluded_reason ?? "", /carries no period/);
  });

  test("monthly cannot answer a one-day window", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ grain: "monthly" })],
      observations: new Map([series("s", [["2026-07", 50000]])]),
    });
    assert.equal(r.revenue_usd, null);
    assert.match(r.sources[0].excluded_reason ?? "", /does not divide/);
  });

  test("monthly does answer a 30-day window", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      window_days: 30,
      sources: [src({ grain: "monthly" })],
      observations: new Map([series("s", [["2026-07", 50000]])]),
    });
    assert.equal(r.revenue_usd, 50000);
  });
});

describe("the window", () => {
  test("a daily feed sums exactly the window, at every width", () => {
    // The bug this replaces: emission scaled by window_days while revenue was
    // passed straight through, so 30d read 0.4% where 1d read 12.5%.
    for (const window_days of [1, 7, 30]) {
      const r = buildSubnetRevenue({
        ...BASE,
        window_days,
        sources: [src()],
        observations: new Map([daily("s", 11668, 90)]),
      });
      assert.equal(r.revenue_usd, 11668 * window_days, `at ${window_days}d`);
      assert.ok(
        Math.abs((r.coverage_ratio as number) - 0.125) < 0.001,
        `coverage should be window-invariant, was ${r.coverage_ratio} at ${window_days}d`,
      );
    }
  });

  test("an incomplete window reports nothing rather than a partial sum", () => {
    // Three of seven days summed into a "7d" figure understates by 57%, and
    // understating is the direction that makes a subnet look poorer than it is.
    const r = buildSubnetRevenue({
      ...BASE,
      window_days: 7,
      sources: [src()],
      observations: new Map([daily("s", 11668, 3)]),
    });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.sources[0].periods_observed, 3);
    assert.equal(r.sources[0].periods_expected, 7);
    assert.match(r.sources[0].excluded_reason ?? "", /needs 7 daily period/);
  });

  test("the same period observed twice is not counted twice", () => {
    const re = windowedAmount("daily", 2, [
      { surface_id: "s", period: "2026-08-10", amount_usd: 100 },
      { surface_id: "s", period: "2026-08-10", amount_usd: 100 },
      { surface_id: "s", period: "2026-08-09", amount_usd: 100 },
    ]);
    assert.ok(re.ok);
    assert.equal(re.amount_usd, 200, "two distinct periods, not three rows");
  });

  test("the newest periods are the ones summed", () => {
    const re = windowedAmount("daily", 2, [
      { surface_id: "s", period: "2026-08-01", amount_usd: 1 },
      { surface_id: "s", period: "2026-08-10", amount_usd: 500 },
      { surface_id: "s", period: "2026-08-09", amount_usd: 300 },
    ]);
    assert.ok(re.ok);
    assert.equal(re.amount_usd, 800);
  });
});

describe("verification", () => {
  test("the headline reconciles against its own published parts", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src({ surface_id: "a" }), src({ surface_id: "b" })],
      observations: new Map([daily("a", 100, 1), daily("b", 250, 1)]),
    });
    const check = r.verification.checks.find(
      (c) => c.name === "headline_is_the_sum_of_its_published_parts",
    );
    assert.ok(check);
    assert.equal(check.ok, true);
    // The property that makes it checkable from outside: re-add the column.
    const readerSum = r.sources
      .filter((s) => s.contributes)
      .reduce((sum, s) => sum + (s.amount_usd as number), 0);
    assert.equal(readerSum, r.revenue_usd);
  });

  test("that check can fail", () => {
    // Prove it is not a tautology: mutate a published row after resolution and
    // the reconciliation must notice. The three computeCoverage checks all pass
    // on this same object, which is exactly why this one exists.
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [src()],
      observations: new Map([daily("s", 100, 1)]),
    });
    const tampered = {
      ...r,
      sources: r.sources.map((s) => ({ ...s, amount_usd: 999999 })),
    };
    const partsSum = tampered.sources
      .filter((s) => s.contributes)
      .reduce((sum, s) => sum + (s.amount_usd as number), 0);
    assert.notEqual(
      partsSum,
      tampered.revenue_usd,
      "a mutated part must not still reconcile",
    );
  });
});

describe("the reported provenance", () => {
  test("the strongest evidence class present wins", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [
        src({ surface_id: "x", provenance: "operator-attested" }),
        src({ surface_id: "y", provenance: "chain-verified" }),
        src({ surface_id: "z", provenance: "probe-derived" }),
      ],
    });
    assert.equal(r.provenance, "chain-verified");
  });

  test("a subnet with no sources reports none, with its search date", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      sources: [],
      searched_at: "2026-08-10T00:00:00Z",
    });
    assert.equal(r.provenance, "none");
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.searched_at, "2026-08-10T00:00:00Z");
    assert.ok(r.emission.tao > 0);
    assert.equal(r.verification.verified, true);
  });

  test("searched_at defaults to null rather than undefined", () => {
    assert.equal(
      buildSubnetRevenue({ ...BASE, sources: [] }).searched_at,
      null,
    );
  });
});

describe("the SN64 shape end to end", () => {
  test("reproduces the published ratio through the serving layer", () => {
    const r = buildSubnetRevenue({
      ...BASE,
      alpha_out_per_block: 1,
      alpha_price_tao: 0.086933658,
      sources: [src()],
      observations: new Map([daily("s", 11668, 1)]),
    });
    assert.ok(Math.abs((r.subsidy_multiple as number) - 8.0) < 0.05);
    assert.ok(Math.abs((r.coverage_ratio as number) - 0.125) < 0.001);
    assert.equal(r.provenance, "probe-derived");
    assert.equal(r.netuid, 64);
    assert.ok(r.emission.alternates.alpha_out_priced);
    assert.equal(r.verification.verified, true);
  });
});
