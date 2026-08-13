// #10484: the accrual half of the money map.
//
// The two mechanics #10440 says a naive design gets wrong are both asserted
// here: the cut is 18% rather than one sixth, and it is paid in ALPHA, so
// pricing it needs the subnet's own alpha price rather than a TAO figure.
//
// The third, which cost the most to find: SubnetOwnerCut is UNSET on chain, so
// the share must be READ from network-parameters' effective field. This module
// refuses to default it -- a caller that passes null gets a null accrual and a
// stated reason, never a silent 18%.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BLOCKS_PER_DAY,
  computeOwnerCutAccrual,
  computeOwnerCutAccrualSeries,
} from "../src/owner-cut-accrual.ts";

/** The runtime default, the value network-parameters resolves an unset item to. */
const OWNER_CUT = 11796 / 65535;

/** SN64 as the economics capture reports it. */
const SN64 = {
  netuid: 64,
  alpha_out_per_block: 1,
  alpha_price_tao: 0.086933658,
  usd_per_tao: 204.03,
  owner_cut: OWNER_CUT,
};

describe("the accrual", () => {
  test("is 18% of a day's alpha emission, priced through alpha", () => {
    const r = computeOwnerCutAccrual(SN64);
    // 1 alpha/block x 7200 x 0.17999... = 1295.9 alpha/day, the figure #10440
    // quotes as the standing accrual rate.
    assert.ok(Math.abs((r.alpha as number) - 7200 * OWNER_CUT) < 1e-6);
    assert.ok(Math.abs((r.alpha as number) - 1295.9) < 0.1);
    assert.ok(
      Math.abs((r.tao as number) - (r.alpha as number) * 0.086933658) < 1e-6,
    );
    assert.ok(Math.abs((r.usd as number) - (r.tao as number) * 204.03) < 1e-3);
    assert.equal(r.accrues, true);
    assert.equal(r.reason, null);
  });

  test("18%, not one sixth", () => {
    // The difference is 7200 x (11796/65535 - 1/6) = 95.96 alpha/day, which at
    // SN64's alpha price is 8.34 TAO/day. #10440 quotes ~6 TAO/day for this
    // gap; that figure was taken at a different alpha_out_emission, so the
    // arithmetic is asserted here rather than the epic's number.
    const correct = computeOwnerCutAccrual(SN64);
    const sixth = computeOwnerCutAccrual({ ...SN64, owner_cut: 1 / 6 });
    const deltaAlpha = (correct.alpha as number) - (sixth.alpha as number);
    assert.ok(
      Math.abs(deltaAlpha - 7200 * (11796 / 65535 - 1 / 6)) < 1e-6,
      `delta was ${deltaAlpha} alpha/day`,
    );
    // Whatever the emission, the error is real money and one-directional:
    // one sixth always UNDER-reports what the owner was credited.
    assert.ok((correct.tao as number) > (sixth.tao as number));
  });

  test("echoes the share it applied, so nobody has to assume 18%", () => {
    assert.equal(computeOwnerCutAccrual(SN64).owner_cut, OWNER_CUT);
  });

  test("scales with the window", () => {
    const one = computeOwnerCutAccrual(SN64);
    const seven = computeOwnerCutAccrual({ ...SN64, window_days: 7 });
    assert.ok(
      Math.abs((seven.alpha as number) - (one.alpha as number) * 7) < 1e-6,
    );
    assert.equal(seven.window_days, 7);
  });
});

describe("zero and null are different answers", () => {
  test("owner_cut_enabled false is a REAL zero, with a reason", () => {
    // The one zero this function produces: a fact about the subnet, not about
    // our reading of it.
    const r = computeOwnerCutAccrual({ ...SN64, owner_cut_enabled: false });
    assert.equal(r.alpha, 0);
    assert.equal(r.tao, 0);
    assert.equal(r.usd, 0);
    assert.equal(r.accrues, false);
    assert.match(String(r.reason), /owner_cut_enabled is false/);
  });

  test("an unread cut share is NULL, never a silent 18%", () => {
    // The trap this module exists for. SubnetOwnerCut is unset on chain, so a
    // caller reading the RAW field gets null -- and defaulting here would hide
    // that the parameter was never resolved.
    for (const owner_cut of [null, undefined]) {
      const r = computeOwnerCutAccrual({ ...SN64, owner_cut });
      assert.equal(r.alpha, null);
      assert.equal(r.usd, null);
      assert.equal(r.accrues, false);
      assert.match(String(r.reason), /owner cut share not read/);
    }
  });

  test("a zero share accrues zero rather than being treated as unread", () => {
    // 0 is a legitimate value for the parameter. It must not read as "missing".
    const r = computeOwnerCutAccrual({ ...SN64, owner_cut: 0 });
    assert.equal(r.alpha, 0);
    assert.equal(r.accrues, false);
    assert.equal(r.reason, null);
  });

  test("unreadable emission is null, not zero", () => {
    for (const alpha_out_per_block of [null, undefined, Number.NaN, -1]) {
      const r = computeOwnerCutAccrual({ ...SN64, alpha_out_per_block });
      assert.equal(r.alpha, null);
      assert.match(String(r.reason), /alpha_out_emission not read/);
    }
  });

  test("owner_cut_enabled unknown does not assume either way", () => {
    // Absent means we did not read it. Accrual still reports, because the
    // emission is real -- but nothing here claims the flag is true.
    const r = computeOwnerCutAccrual({ ...SN64, owner_cut_enabled: null });
    assert.ok((r.alpha as number) > 0);
  });
});

describe("pricing degrades one leg at a time", () => {
  test("no alpha price keeps the ALPHA figure, which is the measured one", () => {
    // TAO and USD are conversions; dropping the measurement because a
    // conversion is unavailable throws away the part we actually know.
    const r = computeOwnerCutAccrual({ ...SN64, alpha_price_tao: null });
    assert.ok((r.alpha as number) > 0);
    assert.equal(r.tao, null);
    assert.equal(r.usd, null);
    assert.match(String(r.reason), /no alpha price/);
  });

  test("no TAO/USD rate keeps alpha and TAO", () => {
    for (const usd_per_tao of [null, 0]) {
      const r = computeOwnerCutAccrual({ ...SN64, usd_per_tao });
      assert.ok((r.alpha as number) > 0);
      assert.ok((r.tao as number) > 0);
      assert.equal(r.usd, null, `usd_per_tao=${usd_per_tao}`);
      assert.match(String(r.reason), /no TAO\/USD rate/);
    }
  });

  test("alpha is priced through the SUBNET's own price, not a shared one", () => {
    // 1 alpha on two subnets is two different values; a shared rate would make
    // the two comparable by token count, which is meaningless.
    const a = computeOwnerCutAccrual({ ...SN64, alpha_price_tao: 0.1 });
    const b = computeOwnerCutAccrual({
      ...SN64,
      netuid: 51,
      alpha_price_tao: 0.5,
    });
    assert.ok(Math.abs((b.tao as number) / (a.tao as number) - 5) < 1e-9);
  });
});

describe("the network series", () => {
  const ROWS = [
    { netuid: 64, alpha_out_emission: 1, alpha_price_tao: 0.0869 },
    { netuid: 51, alpha_out_emission: 0.5, alpha_price_tao: 0.02 },
    // Unreadable, and included rather than dropped.
    { netuid: 7, alpha_out_emission: null, alpha_price_tao: null },
    { netuid: "junk" },
  ];

  test("includes the unmeasurable rather than dropping them", () => {
    // Omitting a row would make the measured set look like the whole network.
    const out = computeOwnerCutAccrualSeries(ROWS, {
      owner_cut: OWNER_CUT,
      usd_per_tao: null,
    });
    assert.equal(
      out.length,
      3,
      "the junk netuid is skipped, the null row is not",
    );
    const seven = out.find((r) => r.netuid === 7);
    assert.ok(seven);
    assert.equal(seven.alpha, null);
    assert.match(String(seven.reason), /alpha_out_emission not read/);
  });

  test("applies a per-subnet enabled flag where it was read", () => {
    const out = computeOwnerCutAccrualSeries(ROWS, {
      owner_cut: OWNER_CUT,
      usd_per_tao: null,
      enabledByNetuid: new Map([[51, false]]),
    });
    const disabled = out.find((r) => r.netuid === 51);
    assert.equal(disabled?.alpha, 0);
    assert.match(String(disabled?.reason), /owner_cut_enabled is false/);
    // The subnet with no flag read is unaffected.
    assert.ok((out.find((r) => r.netuid === 64)?.alpha as number) > 0);
  });

  test("junk input yields no rows rather than throwing", () => {
    for (const rows of [null, undefined, [], "no" as unknown as []]) {
      assert.deepEqual(
        computeOwnerCutAccrualSeries(rows as never, {
          owner_cut: OWNER_CUT,
          usd_per_tao: null,
        }),
        [],
      );
    }
  });

  test("BLOCKS_PER_DAY matches the coverage module's own constant", () => {
    // Two modules computing a daily figure from a per-block one must agree, or
    // the accrual and the emission denominator drift against each other.
    assert.equal(BLOCKS_PER_DAY, 7200);
  });
});
