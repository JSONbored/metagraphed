import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  MIN_PUBLISHABLE_AGREEMENT,
  ammCostTao,
  buildValidatorEconomics,
  capBinding,
  earningFloorAlpha,
  eligible,
  marginalRootShare,
  modelAgreement,
  permitFloorAlpha,
  predictPermits,
  setComposition,
  spotPriceTao,
  stakeWeights,
  type ValidatorNeuron,
} from "../src/validator-economics.ts";

// A neuron with sane defaults, so each test states only the field it is about.
function n(uid: number, over: Partial<ValidatorNeuron> = {}): ValidatorNeuron {
  return {
    uid,
    alphaStake: 0,
    rootStake: 0,
    validatorPermit: false,
    dividends: 0,
    active: false,
    ...over,
  };
}

// Shaped like SN83 CliqueAI on 2026-08-03 — the one subnet of 128 whose validator
// cap is actually full, and the only place the marginal-holder floor is exercised.
function cappedSubnet(): ValidatorNeuron[] {
  const rows: ValidatorNeuron[] = [];
  for (let uid = 0; uid < 64; uid += 1) {
    rows.push(
      n(uid, {
        alphaStake: 3000 + uid,
        validatorPermit: true,
        dividends: uid < 7 ? 1 : 0,
        active: uid < 8,
      }),
    );
  }
  // 90 more clear the 1,000 floor but lose on rank — this is what makes the cap bind.
  for (let uid = 64; uid < 154; uid += 1)
    rows.push(n(uid, { alphaStake: 1500 }));
  for (let uid = 154; uid < 256; uid += 1)
    rows.push(n(uid, { alphaStake: 10 }));
  return rows;
}

describe("ammCostTao", () => {
  test("prices a purchase by constant product, not by spot", () => {
    // Spot would say 1000 * (25000/3_000_000) = 8.333; execution is strictly worse.
    const cost = ammCostTao(25_000, 3_000_000, 1000);
    assert.ok(cost !== null);
    assert.ok(cost > 8.333);
    assert.ok(Math.abs(cost - (25_000 * 1000) / 2_999_000) < 1e-9);
  });

  test("returns null rather than a number the pool cannot honour", () => {
    // Each of these would otherwise surface as a suspiciously cheap subnet.
    assert.equal(ammCostTao(0, 3_000_000, 1000), null, "no tao side");
    assert.equal(ammCostTao(25_000, 0, 1000), null, "no alpha side");
    assert.equal(ammCostTao(-1, 3_000_000, 1000), null, "negative tao side");
    assert.equal(
      ammCostTao(25_000, 500, 500),
      null,
      "amount consumes the pool",
    );
    assert.equal(ammCostTao(25_000, 500, 900), null, "amount beyond the pool");
    assert.equal(ammCostTao(25_000, 3_000_000, 0), null, "zero amount");
    assert.equal(ammCostTao(25_000, 3_000_000, -5), null, "negative amount");
    assert.equal(ammCostTao(NaN, 3_000_000, 1000), null, "non-finite tao side");
    assert.equal(ammCostTao(25_000, NaN, 1000), null, "non-finite alpha side");
    assert.equal(ammCostTao(25_000, 3_000_000, NaN), null, "non-finite amount");
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

describe("stakeWeights", () => {
  test("combines a normalised alpha leg with a taoWeight-scaled root leg", () => {
    const rows = [
      n(0, { alphaStake: 750, rootStake: 0 }),
      n(1, { alphaStake: 250, rootStake: 100 }),
    ];
    const w = stakeWeights(rows, 0.18);
    assert.equal(w.get(0), 0.75);
    // 0.25 alpha share + 0.18 * the whole root pool.
    assert.ok(Math.abs((w.get(1) ?? 0) - (0.25 + 0.18)) < 1e-12);
  });

  test("a leg with no total contributes zero instead of dividing by it", () => {
    const noRoot = stakeWeights([n(0, { alphaStake: 100 })], 0.18);
    assert.equal(noRoot.get(0), 1);
    const noAlpha = stakeWeights([n(0, { rootStake: 100 })], 0.18);
    assert.ok(Math.abs((noAlpha.get(0) ?? 0) - 0.18) < 1e-12);
    const neither = stakeWeights([n(0)], 0.18);
    assert.equal(neither.get(0), 0);
  });
});

describe("eligible", () => {
  test("is the alpha floor, and it is inclusive at the threshold", () => {
    const rows = [
      n(0, { alphaStake: 1000 }),
      n(1, { alphaStake: 999.99 }),
      n(2, { alphaStake: 5000 }),
    ];
    assert.deepEqual(
      eligible(rows, 1000).map((r) => r.uid),
      [0, 2],
    );
  });

  test("root stake does not lift a neuron over the floor", () => {
    // The measured case: 204,767 TAO of root, excluded at 942 alpha against a 1,000 floor.
    const rows = [n(0, { alphaStake: 942, rootStake: 204_767 })];
    assert.deepEqual(eligible(rows, 1000), []);
  });
});

describe("predictPermits", () => {
  test("takes the top-k by stake weight among those clearing the floor", () => {
    const rows = [
      n(0, { alphaStake: 5000 }),
      n(1, { alphaStake: 3000 }),
      n(2, { alphaStake: 2000 }),
      n(3, { alphaStake: 500 }), // below the floor, so rank never applies
    ];
    assert.deepEqual([...predictPermits(rows, 2, 1000, 0.18)].sort(), [0, 1]);
  });

  test("breaks weight ties by uid so the set is deterministic", () => {
    const rows = [n(7, { alphaStake: 2000 }), n(3, { alphaStake: 2000 })];
    assert.deepEqual([...predictPermits(rows, 1, 1000, 0.18)], [3]);
  });

  test("claims no permit when every eligible UID carries zero weight", () => {
    // Reachable only when the threshold is itself zero, which a sudo change could do.
    assert.equal(predictPermits([n(0), n(1)], 2, 0, 0.18).size, 0);
  });
});

describe("modelAgreement", () => {
  test("scores a subnet the rule reproduces exactly", () => {
    const a = modelAgreement(cappedSubnet(), 64, 1000, 0.18);
    assert.equal(a.observedPermits, 64);
    assert.equal(a.matched, 64);
    assert.equal(a.overPredicted, 0);
    assert.equal(a.underPredicted, 0);
    assert.equal(a.agreement, 1);
    assert.equal(a.publishable, true);
  });

  test("counts over- and under-prediction separately, not as one score", () => {
    // uid 1 holds a permit below the floor (the shape of all 11 real-world misses);
    // uid 2 clears the floor and outranks it but the chain granted nothing.
    const rows = [
      n(0, { alphaStake: 5000, validatorPermit: true }),
      n(1, { alphaStake: 200, validatorPermit: true }),
      n(2, { alphaStake: 4000 }),
    ];
    const a = modelAgreement(rows, 2, 1000, 0.18);
    assert.equal(a.matched, 1);
    assert.equal(a.underPredicted, 1, "the sub-floor permit-holder");
    assert.equal(
      a.overPredicted,
      1,
      "the unpermitted UID the model would seat",
    );
    assert.equal(a.agreement, 0.5);
    assert.equal(a.publishable, false);
  });

  test("a subnet with no permits yet is not evidence of drift", () => {
    const a = modelAgreement([n(0, { alphaStake: 10 })], 64, 1000, 0.18);
    assert.equal(a.observedPermits, 0);
    assert.equal(a.agreement, null);
    assert.equal(a.publishable, true, "no denominator is not disagreement");
  });

  test("the publishable boundary is inclusive", () => {
    // 20 permits, one of them below the floor => agreement exactly 0.95.
    const rows: ValidatorNeuron[] = [];
    for (let uid = 0; uid < 19; uid += 1) {
      rows.push(n(uid, { alphaStake: 5000 - uid, validatorPermit: true }));
    }
    rows.push(n(19, { alphaStake: 100, validatorPermit: true }));
    const a = modelAgreement(rows, 19, 1000, 0.18);
    assert.equal(a.agreement, MIN_PUBLISHABLE_AGREEMENT);
    assert.equal(a.publishable, true);
  });
});

describe("capBinding and permitFloorAlpha", () => {
  test("an uncontested subnet floors at the threshold, not at what incumbents hold", () => {
    // The 127-of-128 case: 9 permit-holders far above the floor, 128 slots.
    const rows = [
      n(0, { alphaStake: 8041, validatorPermit: true }),
      n(1, { alphaStake: 646 }),
    ];
    assert.equal(capBinding(rows, 128, 1000), false);
    assert.equal(permitFloorAlpha(rows, 128, 1000, 0.18), 1000);
  });

  test("a full subnet floors at the marginal holder", () => {
    const rows = cappedSubnet();
    assert.equal(capBinding(rows, 64, 1000), true);
    // Ranked by weight descending, the 64th seat is the lowest of the 3000+uid band.
    assert.equal(permitFloorAlpha(rows, 64, 1000, 0.18), 3000);
  });

  test("the floor never drops below the threshold even when the marginal holder is at it", () => {
    const rows = [n(0, { alphaStake: 1000 }), n(1, { alphaStake: 1000 })];
    assert.equal(capBinding(rows, 2, 1000), true);
    assert.equal(permitFloorAlpha(rows, 2, 1000, 0.18), 1000);
  });
});

describe("earningFloorAlpha and setComposition", () => {
  test("permitted, active and earning are three different counts", () => {
    // SN83's real shape: 64 / 8 / 7.
    assert.deepEqual(setComposition(cappedSubnet()), {
      permitted: 64,
      active: 8,
      earning: 7,
    });
  });

  test("the earning floor is the smallest EARNING holder, not the smallest holder", () => {
    const rows = [
      n(0, { alphaStake: 1200, validatorPermit: true, dividends: 0 }),
      n(1, { alphaStake: 9000, validatorPermit: true, dividends: 0.5 }),
      n(2, { alphaStake: 4000, validatorPermit: true, dividends: 0.2 }),
      n(3, { alphaStake: 50, dividends: 9 }), // earning but unpermitted: a miner
    ];
    assert.equal(earningFloorAlpha(rows), 4000);
  });

  test("is null when the subnet pays nobody", () => {
    assert.equal(
      earningFloorAlpha([n(0, { alphaStake: 5000, validatorPermit: true })]),
      null,
    );
  });
});

describe("marginalRootShare", () => {
  test("saturates against the root already present", () => {
    const rows = [n(0, { rootStake: 1_000_000 })];
    const small = marginalRootShare(rows, 5_000, 0.18);
    const large = marginalRootShare(rows, 500_000, 0.18);
    assert.ok(large > small);
    // Even a huge position cannot exceed the taoWeight ceiling.
    assert.ok(marginalRootShare(rows, 1e12, 0.18) < 0.18);
  });

  test("is zero when there is no root anywhere, including our own", () => {
    assert.equal(marginalRootShare([n(0)], 0, 0.18), 0);
  });
});

describe("buildValidatorEconomics", () => {
  const base = {
    neurons: cappedSubnet(),
    maxValidators: 64,
    stakeThresholdAlpha: 1000,
    taoWeight: 0.18,
    taoReserve: 25_000,
    alphaReserve: 3_000_000,
    recycleCostTao: 0.5,
  };

  test("publishes floors, costs and composition when every input is present", () => {
    const out = buildValidatorEconomics(base);
    assert.equal(out.degradedReason, null);
    assert.equal(out.permitFloorAlpha, 3000);
    assert.equal(out.capBinding, true);
    assert.deepEqual(out.composition, { permitted: 64, active: 8, earning: 7 });
    assert.ok(out.permitEntryCostTao !== null && out.permitEntryCostTao > 0.5);
    assert.ok(out.earningEntryCostTao !== null);
    assert.equal(out.modelAgreement?.publishable, true);
  });

  test("withholds rather than guessing when a chain parameter is missing", () => {
    for (const missing of [
      { stakeThresholdAlpha: null },
      { taoWeight: null },
    ]) {
      const out = buildValidatorEconomics({ ...base, ...missing });
      assert.equal(out.permitFloorAlpha, null);
      assert.equal(out.permitEntryCostTao, null);
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
    assert.equal(out.permitFloorAlpha, null);
  });

  test("withholds the floor when the model has drifted, but still shows why", () => {
    const drifted = [
      n(0, { alphaStake: 5000, validatorPermit: true }),
      n(1, { alphaStake: 200, validatorPermit: true }),
      n(2, { alphaStake: 4000 }),
    ];
    const out = buildValidatorEconomics({
      ...base,
      neurons: drifted,
      maxValidators: 2,
    });
    assert.equal(
      out.permitFloorAlpha,
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

  test("keeps the alpha floors when only the reserves are missing", () => {
    const out = buildValidatorEconomics({
      ...base,
      taoReserve: null,
      alphaReserve: null,
    });
    assert.equal(out.permitFloorAlpha, 3000, "the alpha floor is still true");
    assert.equal(out.permitEntryCostTao, null, "only its TAO cost is unknown");
    assert.equal(out.earningEntryCostTao, null);
    assert.equal(
      out.degradedReason,
      "pool reserves unavailable — costs withheld",
    );
  });

  test("reports a null earning floor without withholding the permit floor", () => {
    const noEarners = cappedSubnet().map((row) => ({ ...row, dividends: 0 }));
    const out = buildValidatorEconomics({ ...base, neurons: noEarners });
    assert.equal(out.permitFloorAlpha, 3000);
    assert.equal(out.earningFloorAlpha, null);
    assert.equal(out.earningEntryCostTao, null);
    assert.equal(
      out.degradedReason,
      null,
      "nobody earning is a fact, not a degrade",
    );
  });
});
