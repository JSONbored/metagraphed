import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildStakeQuote } from "../src/stake-quote.mjs";

const POOL = { tao_in_pool_tao: 1000, alpha_in_pool: 2000 };

describe("buildStakeQuote (#5235)", () => {
  test("stake direction applies the constant-product formula", () => {
    const quote = buildStakeQuote(POOL, 7, { amount: 100, direction: "stake" });
    // alpha_out = 2000 - (2000*1000)/(1000+100) = 2000 - 1818.181818... = 181.818181...
    assert.equal(quote.schema_version, 1);
    assert.equal(quote.netuid, 7);
    assert.equal(quote.direction, "stake");
    assert.equal(quote.amount_in, 100);
    assert.equal(quote.amount_out, 181.818182);
    assert.equal(quote.spot_price_tao, 0.5);
    // effective price = 100 / 181.818182 = 0.55, worse than spot (buying pushes price up)
    assert.equal(quote.effective_price_tao, 0.55);
    assert.ok(quote.price_impact_pct > 0);
  });

  test("unstake direction applies the inverse formula", () => {
    const quote = buildStakeQuote(POOL, 7, {
      amount: 200,
      direction: "unstake",
    });
    // tao_out = 1000 - (1000*2000)/(2000+200) = 1000 - 909.0909... = 90.9090...
    assert.equal(quote.direction, "unstake");
    assert.equal(quote.amount_in, 200);
    assert.equal(quote.amount_out, 90.909091);
    assert.equal(quote.spot_price_tao, 0.5);
    assert.ok(quote.price_impact_pct > 0);
  });

  test("a larger trade produces a larger price impact than a smaller one (monotonic slippage)", () => {
    const small = buildStakeQuote(POOL, 7, {
      amount: 10,
      direction: "stake",
    });
    const large = buildStakeQuote(POOL, 7, {
      amount: 500,
      direction: "stake",
    });
    assert.ok(large.price_impact_pct > small.price_impact_pct);
  });

  test("root subnet (netuid 0) returns a fixed 1:1, zero-impact quote regardless of pool reserves", () => {
    const quote = buildStakeQuote(null, 0, { amount: 42, direction: "stake" });
    assert.equal(quote.amount_in, 42);
    assert.equal(quote.amount_out, 42);
    assert.equal(quote.spot_price_tao, 1);
    assert.equal(quote.effective_price_tao, 1);
    assert.equal(quote.price_impact_pct, 0);

    const unstakeQuote = buildStakeQuote(POOL, 0, {
      amount: 42,
      direction: "unstake",
    });
    assert.equal(unstakeQuote.amount_out, 42);
    assert.equal(unstakeQuote.price_impact_pct, 0);
  });

  test("zero-liquidity pool is rejected with a descriptive error, not a NaN/Infinity quote", () => {
    for (const row of [
      null,
      { tao_in_pool_tao: null, alpha_in_pool: 2000 },
      { tao_in_pool_tao: 1000, alpha_in_pool: null },
      { tao_in_pool_tao: 0, alpha_in_pool: 2000 },
      { tao_in_pool_tao: 1000, alpha_in_pool: 0 },
    ]) {
      const quote = buildStakeQuote(row, 7, {
        amount: 10,
        direction: "stake",
      });
      assert.equal(quote.error.parameter, "netuid");
      assert.ok(/no pool liquidity/.test(quote.error.message));
    }
  });

  test("a dust amount produces a sane, near-zero-impact quote (no NaN/Infinity)", () => {
    const quote = buildStakeQuote(POOL, 7, {
      amount: 0.000001,
      direction: "stake",
    });
    assert.equal(quote.error, undefined);
    assert.ok(Number.isFinite(quote.amount_out));
    assert.ok(Number.isFinite(quote.price_impact_pct));
    assert.ok(quote.price_impact_pct < 0.001);
  });

  test("an amount over 1000x the relevant pool reserve is rejected (mirrors InsufficientLiquidity)", () => {
    const tooBigStake = buildStakeQuote(POOL, 7, {
      amount: POOL.tao_in_pool_tao * 1000 + 1,
      direction: "stake",
    });
    assert.equal(tooBigStake.error.parameter, "amount");
    assert.ok(/1000x/.test(tooBigStake.error.message));

    const tooBigUnstake = buildStakeQuote(POOL, 7, {
      amount: POOL.alpha_in_pool * 1000 + 1,
      direction: "unstake",
    });
    assert.equal(tooBigUnstake.error.parameter, "amount");

    // Exactly at the boundary is still accepted.
    const atBoundary = buildStakeQuote(POOL, 7, {
      amount: POOL.tao_in_pool_tao * 1000,
      direction: "stake",
    });
    assert.equal(atBoundary.error, undefined);
  });
});
