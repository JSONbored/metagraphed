import { describe, it, expect } from "vitest";
import {
  computeStakeQuote,
  STAKE_QUOTE_DIRECTIONS,
  MAX_INPUT_RESERVE_MULTIPLE,
} from "../src/stake-quote.ts";
import type { Row } from "./row-type.ts";

// Realistic reserves (SN64 from the live economics.json artifact).
const POOL = {
  netuid: 64,
  taoInPool: 201959.938748425,
  alphaInPool: 2730860.150574127,
};

describe("computeStakeQuote", () => {
  it("rejects an unknown direction with 400", () => {
    const r = computeStakeQuote({
      ...POOL,
      amount: 10,
      direction: "swap",
    }) as Row;
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.code).toBe("invalid_direction");
  });

  it("exports the two supported directions", () => {
    expect(STAKE_QUOTE_DIRECTIONS).toEqual(["stake", "unstake"]);
  });

  for (const bad of [0, -5, NaN, Infinity, "10", null, undefined]) {
    it(`rejects a non-positive/non-finite amount (${String(bad)}) with 400`, () => {
      const r = computeStakeQuote({
        ...POOL,
        amount: bad,
        direction: "stake",
      }) as Row;
      expect(r.ok).toBe(false);
      expect(r.status).toBe(400);
      expect(r.code).toBe("invalid_amount");
    });
  }

  it("returns a 1:1 zero-impact quote for the root subnet (netuid 0), stake", () => {
    const r = computeStakeQuote({
      netuid: 0,
      taoInPool: 0,
      alphaInPool: 0,
      amount: 42,
      direction: "stake",
    }) as Row;
    expect(r.ok).toBe(true);
    expect(r.quote.is_root).toBe(true);
    expect(r.quote.expected_out).toBe(42);
    expect(r.quote.expected_out_unit).toBe("alpha");
    expect(r.quote.price_impact_pct).toBe(0);
    expect(r.quote.spot_price_tao).toBe(1);
  });

  it("returns a 1:1 quote for the root subnet, unstake (tao out)", () => {
    const r = computeStakeQuote({
      netuid: 0,
      taoInPool: 5,
      alphaInPool: 5,
      amount: 7,
      direction: "unstake",
    }) as Row;
    expect(r.ok).toBe(true);
    expect(r.quote.expected_out_unit).toBe("tao");
    expect(r.quote.expected_out).toBe(7);
  });

  for (const pool of [
    { taoInPool: 0, alphaInPool: 100 },
    { taoInPool: 100, alphaInPool: 0 },
    { taoInPool: NaN, alphaInPool: 100 },
  ]) {
    it(`returns 422 insufficient_liquidity for a zero/invalid reserve (${JSON.stringify(pool)})`, () => {
      const r = computeStakeQuote({
        netuid: 7,
        ...pool,
        amount: 1,
        direction: "stake",
      }) as Row;
      expect(r.ok).toBe(false);
      expect(r.status).toBe(422);
      expect(r.code).toBe("insufficient_liquidity");
    });
  }

  it("computes a stake quote: alpha out, effective price > spot, positive impact", () => {
    const amount = 1000; // TAO in
    const r = computeStakeQuote({ ...POOL, amount, direction: "stake" }) as Row;
    expect(r.ok).toBe(true);
    const q = r.quote;
    // Constant product: alpha_out = alpha_in - k/(tao_in + Δtao).
    const k = POOL.taoInPool * POOL.alphaInPool;
    const expectedAlpha = POOL.alphaInPool - k / (POOL.taoInPool + amount);
    expect(q.expected_out).toBeCloseTo(expectedAlpha, 6);
    expect(q.expected_out_unit).toBe("alpha");
    expect(q.spot_price_tao).toBeCloseTo(POOL.taoInPool / POOL.alphaInPool, 12);
    // Buying alpha pushes its price up → you pay more TAO/alpha than spot.
    expect(q.effective_price_tao).toBeGreaterThan(q.spot_price_tao);
    expect(q.price_impact_pct).toBeGreaterThan(0);
    expect(q.is_root).toBe(false);
  });

  it("computes an unstake quote: tao out, effective price < spot, positive impact", () => {
    const amount = 50000; // alpha in
    const r = computeStakeQuote({
      ...POOL,
      amount,
      direction: "unstake",
    }) as Row;
    expect(r.ok).toBe(true);
    const q = r.quote;
    const k = POOL.taoInPool * POOL.alphaInPool;
    const expectedTao = POOL.taoInPool - k / (POOL.alphaInPool + amount);
    expect(q.expected_out).toBeCloseTo(expectedTao, 6);
    expect(q.expected_out_unit).toBe("tao");
    // Selling alpha pushes its price down → you receive less TAO/alpha than spot.
    expect(q.effective_price_tao).toBeLessThan(q.spot_price_tao);
    expect(q.price_impact_pct).toBeGreaterThan(0);
  });

  it("gives a near-zero impact for a dust stake amount", () => {
    const r = computeStakeQuote({
      ...POOL,
      amount: 1e-6,
      direction: "stake",
    }) as Row;
    expect(r.ok).toBe(true);
    expect(r.quote.expected_out).toBeGreaterThan(0);
    expect(r.quote.price_impact_pct).toBeLessThan(0.001);
  });

  it("rejects a stake amount over 1000× the TAO reserve with 422", () => {
    const amount = MAX_INPUT_RESERVE_MULTIPLE * POOL.taoInPool + 1;
    const r = computeStakeQuote({ ...POOL, amount, direction: "stake" }) as Row;
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.code).toBe("insufficient_liquidity");
  });

  it("rejects an unstake amount over 1000× the alpha reserve with 422", () => {
    const amount = MAX_INPUT_RESERVE_MULTIPLE * POOL.alphaInPool + 1;
    const r = computeStakeQuote({
      ...POOL,
      amount,
      direction: "unstake",
    }) as Row;
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
    expect(r.code).toBe("insufficient_liquidity");
  });
});
