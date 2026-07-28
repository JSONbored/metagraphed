import { describe, expect, it } from "vitest";
import { resolvePriceAtTx } from "../src/price-at-tx.ts";

const row = (over: Record<string, unknown> = {}) => ({
  netuid: 64,
  alpha_amount: 2,
  amount_tao: 1,
  ...over,
});

describe("resolvePriceAtTx (#8369)", () => {
  it("resolves the trade's own execution price from both legs", () => {
    expect(resolvePriceAtTx(row({ amount_tao: 10, alpha_amount: 4 }))).toEqual({
      price_at_tx: 2.5,
      price_basis: "trade_exact",
    });
  });

  it("rounds to rao precision rather than leaking IEEE-754 dust", () => {
    // 1/3 would otherwise carry 17 significant digits into the JSON payload.
    const { price_at_tx } = resolvePriceAtTx(
      row({ amount_tao: 1, alpha_amount: 3 }),
    );
    expect(price_at_tx).toBe(0.333333333);
  });

  it("reports root (netuid 0) as having no pool rather than a meaningless 1.0", () => {
    // Root staking is 1:1 TAO<->TAO with no AMM, so a price there would be a
    // constant that invites false comparison against real subnet prices.
    expect(
      resolvePriceAtTx(row({ netuid: 0, amount_tao: 5, alpha_amount: 5 })),
    ).toEqual({
      price_at_tx: null,
      price_basis: "root_no_pool",
    });
  });

  it("returns null for a non-swap event (no alpha leg), e.g. a transfer", () => {
    expect(resolvePriceAtTx(row({ alpha_amount: null }))).toEqual({
      price_at_tx: null,
      price_basis: null,
    });
  });

  it("never divides by a zero or negative alpha leg", () => {
    for (const alpha_amount of [0, -3]) {
      expect(resolvePriceAtTx(row({ alpha_amount }))).toEqual({
        price_at_tx: null,
        price_basis: null,
      });
    }
  });

  it("rejects non-finite legs instead of emitting NaN/Infinity", () => {
    expect(resolvePriceAtTx(row({ alpha_amount: "abc" }))).toEqual({
      price_at_tx: null,
      price_basis: null,
    });
    expect(resolvePriceAtTx(row({ amount_tao: "abc" }))).toEqual({
      price_at_tx: null,
      price_basis: null,
    });
  });

  it("accepts numeric strings, since Postgres NUMERIC reads back as a string", () => {
    // postgres.js with fetch_types:false returns NUMERIC columns as strings —
    // the same BIGINT-as-string discipline the rest of the read path applies.
    expect(
      resolvePriceAtTx(row({ amount_tao: "10", alpha_amount: "4" })),
    ).toEqual({
      price_at_tx: 2.5,
      price_basis: "trade_exact",
    });
  });

  it("rejects a quotient that overflows to Infinity, even from two finite legs", () => {
    // Both legs individually pass their guards, but MAX_VALUE / a subnormal
    // denominator overflows — so the finiteness check has to be on the
    // RESULT, not just the inputs.
    expect(
      resolvePriceAtTx(
        row({ amount_tao: Number.MAX_VALUE, alpha_amount: 5e-324 }),
      ),
    ).toEqual({
      price_at_tx: null,
      price_basis: null,
    });
  });

  it("survives a null/undefined/non-object row instead of throwing", () => {
    for (const bad of [null, undefined, 42 as unknown]) {
      expect(resolvePriceAtTx(bad as never)).toEqual({
        price_at_tx: null,
        price_basis: null,
      });
    }
  });

  it("does not report a subnet-less event as root — Number(null) is 0", () => {
    // Regression: a Transfer carries netuid null, and a bare Number()
    // coercion made it look like netuid 0, so transfers were reported with
    // basis "root_no_pool" — a wrong reason stated confidently. The absence
    // of a price on a transfer is "not applicable", not "root has no pool".
    for (const netuid of [null, undefined, ""]) {
      expect(resolvePriceAtTx(row({ netuid, alpha_amount: null }))).toEqual({
        price_at_tx: null,
        price_basis: null,
      });
    }
  });

  it("still prices a normal subnet swap when netuid is absent from the row", () => {
    expect(resolvePriceAtTx({ alpha_amount: 4, amount_tao: 10 })).toEqual({
      price_at_tx: 2.5,
      price_basis: "trade_exact",
    });
  });
});
