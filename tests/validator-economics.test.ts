import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MIN_PUBLISHABLE_AGREEMENT,
  ammCostTao,
  ammProceedsTao,
  buildValidatorEconomics,
  capBinding,
  earningFloorUnits,
  eligible,
  modelAgreement,
  permitFloorUnits,
  predictPermits,
  rootTaoToClear,
  setComposition,
  shareOfSubnet,
  spotPriceTao,
  subnetStakeTotal,
  type ValidatorNeuron,
} from "../src/validator-economics.ts";

// A neuron with sane defaults, so each test states only the field it is about.
function n(uid: number, over: Partial<ValidatorNeuron> = {}): ValidatorNeuron {
  return {
    uid,
    totalStake: 0,
    validatorPermit: false,
    dividends: 0,
    active: false,
    ...over,
  };
}

// Shaped like SN83 CliqueAI on 2026-08-03 — the one subnet of 128 whose validator cap is
// actually full, and the only place the marginal-holder floor is exercised.
function cappedSubnet(): ValidatorNeuron[] {
  const rows: ValidatorNeuron[] = [];
  for (let uid = 0; uid < 64; uid += 1) {
    rows.push(
      n(uid, {
        totalStake: 3000 + uid,
        validatorPermit: true,
        dividends: uid < 7 ? 1 : 0,
        active: uid < 8,
      }),
    );
  }
  // 90 more clear the threshold but lose on rank — this is what makes the cap bind.
  for (let uid = 64; uid < 154; uid += 1)
    rows.push(n(uid, { totalStake: 1500 }));
  for (let uid = 154; uid < 256; uid += 1)
    rows.push(n(uid, { totalStake: 10 }));
  return rows;
}

describe("ammCostTao / ammProceedsTao", () => {
  test("buying is priced by constant product and is worse than spot", () => {
    const cost = ammCostTao(25_000, 3_000_000, 1000);
    assert.ok(cost !== null);
    assert.ok(cost > (25_000 / 3_000_000) * 1000);
    assert.ok(Math.abs(cost - (25_000 * 1000) / 2_999_000) < 1e-9);
  });

  test("selling is the mirror image, and yields LESS than spot", () => {
    // Rewards accrue as alpha, so this is the path every realised revenue figure takes.
    const out = ammProceedsTao(25_000, 3_000_000, 1000);
    assert.ok(out !== null);
    assert.ok(
      out < (25_000 / 3_000_000) * 1000,
      "selling drains the pool it is priced against",
    );
    assert.ok(Math.abs(out - (25_000 * 1000) / 3_001_000) < 1e-9);
    const cost = ammCostTao(25_000, 3_000_000, 1000);
    assert.ok(
      cost !== null && cost > out,
      "round-tripping loses money, as it must",
    );
  });

  test("both return null rather than a number the pool cannot honour", () => {
    for (const fn of [ammCostTao, ammProceedsTao]) {
      assert.equal(fn(0, 3_000_000, 1000), null, "no tao side");
      assert.equal(fn(25_000, 0, 1000), null, "no alpha side");
      assert.equal(fn(-1, 3_000_000, 1000), null, "negative tao side");
      assert.equal(fn(25_000, 3_000_000, 0), null, "zero amount");
      assert.equal(fn(25_000, 3_000_000, -5), null, "negative amount");
      assert.equal(fn(NaN, 3_000_000, 1000), null, "non-finite tao side");
      assert.equal(fn(25_000, NaN, 1000), null, "non-finite alpha side");
      assert.equal(fn(25_000, 3_000_000, NaN), null, "non-finite amount");
    }
    // Only the BUY side diverges as the amount approaches the pool.
    assert.equal(ammCostTao(25_000, 500, 500), null, "buy consumes the pool");
    assert.equal(ammCostTao(25_000, 500, 900), null, "buy beyond the pool");
    assert.ok(
      ammProceedsTao(25_000, 500, 900) !== null,
      "selling more than the pool is fine",
    );
  });
});

describe("spotPriceTao", () => {
  test("is reserves-derived, and null when there is no alpha side", () => {
    assert.equal(spotPriceTao(25_000, 2_500_000), 0.01);
    assert.equal(spotPriceTao(25_000, 0), null);
    assert.equal(spotPriceTao(NaN, 2_500_000), null);
    assert.equal(spotPriceTao(25_000, NaN), null);
  });
});

describe("rootTaoToClear", () => {
  test("root is not split, so this clears every subnet at once", () => {
    // The headline number: 1000 / 0.18 = 5,555.6 TAO.
    const r = rootTaoToClear(1000, 0.18);
    assert.ok(r !== null && Math.abs(r - 5555.5555) < 0.01);
  });

  test("null when tao_weight is unusable rather than dividing by it", () => {
    assert.equal(rootTaoToClear(1000, 0), null);
    assert.equal(rootTaoToClear(1000, -0.1), null);
    assert.equal(rootTaoToClear(NaN, 0.18), null);
    assert.equal(rootTaoToClear(1000, NaN), null);
  });
});

describe("eligible", () => {
  test("tests total_stake, which already contains the root leg", () => {
    const rows = [
      n(0, { totalStake: 1000 }),
      n(1, { totalStake: 999.99 }),
      n(2, { totalStake: 5000 }),
    ];
    assert.deepEqual(
      eligible(rows, 1000).map((r) => r.uid),
      [0, 2],
      "inclusive at the threshold",
    );
  });
});

describe("predictPermits", () => {
  test("takes the top-k by total stake among those clearing the threshold", () => {
    const rows = [
      n(0, { totalStake: 5000 }),
      n(1, { totalStake: 3000 }),
      n(2, { totalStake: 2000 }),
      n(3, { totalStake: 500 }), // below the threshold, so rank never applies
    ];
    assert.deepEqual([...predictPermits(rows, 2, 1000)].sort(), [0, 1]);
  });

  test("breaks ties by uid so the set is deterministic", () => {
    const rows = [n(7, { totalStake: 2000 }), n(3, { totalStake: 2000 })];
    assert.deepEqual([...predictPermits(rows, 1, 1000)], [3]);
  });

  test("claims no permit when every eligible UID carries zero stake", () => {
    // Reachable only if the threshold is itself zero, which a governance change could do.
    assert.equal(predictPermits([n(0), n(1)], 2, 0).size, 0);
  });
});

describe("modelAgreement", () => {
  test("scores a subnet the rule reproduces exactly", () => {
    const a = modelAgreement(cappedSubnet(), 64, 1000);
    assert.equal(a.observedPermits, 64);
    assert.equal(a.matched, 64);
    assert.equal(a.overPredicted, 0);
    assert.equal(a.underPredicted, 0);
    assert.equal(a.agreement, 1);
    assert.equal(a.publishable, true);
  });

  test("counts over- and under-prediction separately, not as one score", () => {
    const rows = [
      n(0, { totalStake: 5000, validatorPermit: true }),
      n(1, { totalStake: 200, validatorPermit: true }), // sub-threshold permit: a stale one
      n(2, { totalStake: 4000 }), // clears and outranks, but the chain granted nothing
    ];
    const a = modelAgreement(rows, 2, 1000);
    assert.equal(a.matched, 1);
    assert.equal(a.underPredicted, 1);
    assert.equal(a.overPredicted, 1);
    assert.equal(a.agreement, 0.5);
    assert.equal(a.publishable, false);
  });

  test("a subnet with no permits yet is not evidence of drift", () => {
    const a = modelAgreement([n(0, { totalStake: 10 })], 64, 1000);
    assert.equal(a.observedPermits, 0);
    assert.equal(a.agreement, null);
    assert.equal(a.publishable, true, "no denominator is not disagreement");
  });

  test("the publishable boundary is inclusive", () => {
    const rows: ValidatorNeuron[] = [];
    for (let uid = 0; uid < 19; uid += 1) {
      rows.push(n(uid, { totalStake: 5000 - uid, validatorPermit: true }));
    }
    rows.push(n(19, { totalStake: 100, validatorPermit: true }));
    const a = modelAgreement(rows, 19, 1000);
    assert.equal(a.agreement, MIN_PUBLISHABLE_AGREEMENT);
    assert.equal(a.publishable, true);
  });
});

describe("capBinding and permitFloorUnits", () => {
  test("an uncontested subnet floors at the threshold, not at what incumbents hold", () => {
    // The 127-of-128 case: permit-holders far above the floor, plenty of open slots.
    const rows = [
      n(0, { totalStake: 8041, validatorPermit: true }),
      n(1, { totalStake: 646 }),
    ];
    assert.equal(capBinding(rows, 128, 1000), false);
    assert.equal(permitFloorUnits(rows, 128, 1000), 1000);
  });

  test("a full subnet floors at the marginal holder", () => {
    const rows = cappedSubnet();
    assert.equal(capBinding(rows, 64, 1000), true);
    assert.equal(permitFloorUnits(rows, 64, 1000), 3000);
  });

  test("the floor never drops below the threshold", () => {
    const rows = [n(0, { totalStake: 1000 }), n(1, { totalStake: 1000 })];
    assert.equal(capBinding(rows, 2, 1000), true);
    assert.equal(permitFloorUnits(rows, 2, 1000), 1000);
  });
});

describe("earningFloorUnits and setComposition", () => {
  test("permitted, active and earning are three different counts", () => {
    assert.deepEqual(setComposition(cappedSubnet()), {
      permitted: 64,
      active: 8,
      earning: 7,
    });
  });

  test("the earning floor is the smallest EARNING holder, not the smallest holder", () => {
    const rows = [
      n(0, { totalStake: 1200, validatorPermit: true, dividends: 0 }),
      n(1, { totalStake: 9000, validatorPermit: true, dividends: 0.5 }),
      n(2, { totalStake: 4000, validatorPermit: true, dividends: 0.2 }),
      n(3, { totalStake: 50, dividends: 9 }), // earning but unpermitted: a miner
    ];
    assert.equal(earningFloorUnits(rows), 4000);
  });

  test("is null when the subnet pays nobody", () => {
    assert.equal(
      earningFloorUnits([n(0, { totalStake: 5000, validatorPermit: true })]),
      null,
    );
  });
});

describe("subnetStakeTotal and shareOfSubnet", () => {
  test("the denominator counts only UIDs above the threshold", () => {
    const rows = [
      n(0, { totalStake: 4000 }),
      n(1, { totalStake: 6000 }),
      n(2, { totalStake: 10 }),
    ];
    assert.equal(subnetStakeTotal(rows, 1000), 10_000);
  });

  test("our share includes our own units in the denominator", () => {
    const rows = [n(0, { totalStake: 9000 })];
    assert.equal(shareOfSubnet(rows, 1000, 1000), 0.1);
  });

  test("below the threshold the share is zero, not proportional", () => {
    // The cliff: sub-threshold means no permit at all, so no dividends.
    assert.equal(shareOfSubnet([n(0, { totalStake: 9000 })], 999, 1000), 0);
  });

  test("an empty subnet yields a zero share rather than dividing by zero", () => {
    assert.equal(shareOfSubnet([], 0, 0), 0);
  });
});

describe("buildValidatorEconomics", () => {
  const base = {
    neurons: cappedSubnet(),
    maxValidators: 64,
    stakeThreshold: 1000,
    taoWeight: 0.18,
    taoReserve: 25_000,
    alphaReserve: 3_000_000,
  };

  test("publishes floors, costs, composition and the root equivalent", () => {
    const out = buildValidatorEconomics(base);
    assert.equal(out.degradedReason, null);
    assert.equal(out.permitFloorUnits, 3000);
    assert.equal(out.capBinding, true);
    assert.deepEqual(out.composition, { permitted: 64, active: 8, earning: 7 });
    assert.ok(out.permitFloorCostTao !== null && out.permitFloorCostTao > 0);
    assert.ok(
      out.rootTaoToClear !== null &&
        Math.abs(out.rootTaoToClear - 5555.5555) < 0.01,
    );
    assert.equal(out.modelAgreement?.publishable, true);
  });

  test("withholds rather than guessing when a chain parameter is missing", () => {
    for (const missing of [{ stakeThreshold: null }, { taoWeight: null }]) {
      const out = buildValidatorEconomics({ ...base, ...missing });
      assert.equal(out.permitFloorUnits, null);
      assert.equal(out.rootTaoToClear, null);
      assert.equal(out.degradedReason, "chain parameters unavailable");
    }
  });

  test("withholds when max_validators is unusable", () => {
    for (const bad of [null, 0]) {
      const out = buildValidatorEconomics({ ...base, maxValidators: bad });
      assert.equal(out.degradedReason, "max_validators unavailable");
      assert.equal(out.capBinding, null);
    }
  });

  test("withholds on an empty metagraph instead of reporting a free subnet", () => {
    const out = buildValidatorEconomics({ ...base, neurons: [] });
    assert.equal(out.degradedReason, "no metagraph rows for this subnet");
    assert.equal(out.permitFloorUnits, null);
  });

  test("withholds the floor when the model has drifted, but still shows why", () => {
    const drifted = [
      n(0, { totalStake: 5000, validatorPermit: true }),
      n(1, { totalStake: 200, validatorPermit: true }),
      n(2, { totalStake: 4000 }),
    ];
    const out = buildValidatorEconomics({
      ...base,
      neurons: drifted,
      maxValidators: 2,
    });
    assert.equal(
      out.permitFloorUnits,
      null,
      "a floor the model cannot justify is not published",
    );
    assert.equal(
      out.degradedReason,
      "permit model disagrees with observed permits on this subnet",
    );
    // The observed facts survive — they are what explains the disagreement.
    assert.deepEqual(out.composition, { permitted: 2, active: 0, earning: 0 });
    assert.equal(out.modelAgreement?.publishable, false);
  });

  test("keeps the unit floors when only the reserves are missing", () => {
    const out = buildValidatorEconomics({
      ...base,
      taoReserve: null,
      alphaReserve: null,
    });
    assert.equal(out.permitFloorUnits, 3000, "the unit floor is still true");
    assert.equal(out.permitFloorCostTao, null, "only its TAO cost is unknown");
    assert.equal(out.earningFloorCostTao, null);
    assert.equal(
      out.degradedReason,
      "pool reserves unavailable — costs withheld",
    );
  });

  test("reports a null earning floor without withholding the permit floor", () => {
    const noEarners = cappedSubnet().map((row) => ({ ...row, dividends: 0 }));
    const out = buildValidatorEconomics({ ...base, neurons: noEarners });
    assert.equal(out.permitFloorUnits, 3000);
    assert.equal(out.earningFloorUnits, null);
    assert.equal(out.earningFloorCostTao, null);
    assert.equal(
      out.degradedReason,
      null,
      "nobody earning is a fact, not a degrade",
    );
  });
});
