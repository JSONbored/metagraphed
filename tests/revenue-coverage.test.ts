// #10446: the ratio, and the null that must never become a zero.
//
// The fixture is the real SN64 measurement from #10448/#10449, so a change that
// silently alters the denominator shows up as a number the epic already
// published.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCKS_PER_DAY,
  OWNER_CUT,
  computeCoverage,
} from "../src/revenue-coverage.ts";

// SN64, 2026-08-10: tao_total 0.063615264/block, TAO $204.03, revenue
// ~$11,668/day. Published in #10439 as 8.0:1 / 12.5%.
const SN64 = {
  tao_total_per_block: 0.063615264,
  alpha_out_per_block: 1,
  alpha_price_tao: 0.086933658,
  usd_per_tao: 204.03,
  window_days: 1,
  revenue_usd: 11668,
};

describe("the published SN64 numbers", () => {
  test("reproduces 8.0:1 and 12.5%", () => {
    const r = computeCoverage(SN64);
    assert.equal(r.emission.basis, "tao_total");
    assert.ok(Math.abs(r.emission.tao - 458.03) < 0.01, `${r.emission.tao}`);
    assert.ok(Math.abs(r.emission.usd - 93452) < 5, `${r.emission.usd}`);
    assert.ok(Math.abs((r.subsidy_multiple ?? 0) - 8.0) < 0.05);
    assert.ok(Math.abs((r.coverage_ratio ?? 0) - 0.125) < 0.001);
    assert.equal(r.verification.verified, true);
  });

  test("the two ratios are reciprocal, and the check says so", () => {
    const r = computeCoverage(SN64);
    assert.ok(
      Math.abs(
        (r.coverage_ratio as number) * (r.subsidy_multiple as number) - 1,
      ) < 1e-6,
    );
    const check = r.verification.checks.find(
      (c) => c.name === "ratios_are_reciprocal",
    );
    assert.equal(check?.ok, true);
  });

  test("a window scales the emission linearly", () => {
    const day = computeCoverage(SN64);
    const week = computeCoverage({ ...SN64, window_days: 7 });
    assert.ok(Math.abs(week.emission.tao - day.emission.tao * 7) < 1e-6);
    assert.equal(week.window_days, 7);
  });
});

describe("absent revenue is null, never zero", () => {
  test("null revenue yields null ratios, not 0", () => {
    // 127 of 129 subnets are in this state. Rendering them "0% covered" would
    // be a false claim about every one of them, at scale.
    const r = computeCoverage({ ...SN64, revenue_usd: null });
    assert.equal(r.revenue_usd, null);
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.subsidy_multiple, null);
    assert.equal(r.verification.verified, true);
    const check = r.verification.checks.find(
      (c) => c.name === "absent_revenue_is_null_not_zero",
    );
    assert.match(check?.detail ?? "", /not observed/);
  });

  test("an OBSERVED zero is different from an absent one", () => {
    // Zero revenue is a measurement: coverage is genuinely 0%. The subsidy
    // multiple is null because dividing by it is undefined, not infinite.
    const r = computeCoverage({ ...SN64, revenue_usd: 0 });
    assert.equal(r.revenue_usd, 0);
    assert.equal(r.coverage_ratio, 0);
    assert.equal(r.subsidy_multiple, null);
    assert.equal(r.verification.verified, true);
  });

  test("zero emission yields null rather than Infinity", () => {
    // An emission-gated subnet has no ratio. Infinity would sort as the worst
    // possible subsidy rather than as "not applicable".
    const r = computeCoverage({ ...SN64, tao_total_per_block: 0 });
    assert.equal(r.coverage_ratio, null);
    assert.equal(r.subsidy_multiple, null);
    const check = r.verification.checks.find(
      (c) => c.name === "emission_is_positive",
    );
    assert.equal(check?.ok, false);
    assert.equal(r.verification.verified, false);
  });
});

describe("the alternate denominators", () => {
  test("alpha_out priced, and owner_take at 18%", () => {
    const r = computeCoverage(SN64);
    const alpha = r.emission.alternates.alpha_out_priced;
    assert.ok(alpha);
    // 1 alpha/block * 7200 * 0.086933658
    assert.ok(Math.abs(alpha.tao - 7200 * 0.086933658) < 1e-6);

    const owner = r.emission.alternates.owner_take;
    assert.ok(Math.abs(owner.tao - r.emission.tao * OWNER_CUT) < 1e-6);
    // 18%, not 1/6 — the difference is ~6 TAO/day here.
    assert.ok(Math.abs(OWNER_CUT - 0.18) < 0.0001);
    assert.ok(Math.abs(owner.tao - r.emission.tao / 6) > 1);
  });

  test("alpha pricing is null when either input is missing", () => {
    for (const missing of [
      { alpha_out_per_block: undefined },
      { alpha_price_tao: undefined },
    ]) {
      const r = computeCoverage({ ...SN64, ...missing });
      assert.equal(r.emission.alternates.alpha_out_priced, null);
      // The published basis is unaffected — an absent alternate must never
      // change the headline denominator.
      assert.equal(r.emission.basis, "tao_total");
      assert.ok(r.emission.tao > 0);
    }
  });
});

describe("bad input throws instead of yielding NaN", () => {
  test("a NaN ratio would serialise as null and be read as 'not observed'", () => {
    for (const bad of [
      { tao_total_per_block: Number.NaN },
      { tao_total_per_block: -1 },
      { usd_per_tao: Number.POSITIVE_INFINITY },
      { usd_per_tao: -0.5 },
      { window_days: Number.NaN },
      { window_days: -7 },
    ]) {
      assert.throws(() => computeCoverage({ ...SN64, ...bad }), /finite/);
    }
    assert.throws(
      () => computeCoverage({ ...SN64, revenue_usd: Number.NaN }),
      /revenue_usd/,
    );
    assert.throws(
      () => computeCoverage({ ...SN64, revenue_usd: -1 }),
      /revenue_usd/,
    );
  });
});

test("BLOCKS_PER_DAY is one day at 12s", () => {
  assert.equal(BLOCKS_PER_DAY, 7200);
  assert.equal((86400 / 12) | 0, BLOCKS_PER_DAY);
});
