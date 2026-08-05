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
  takeDistribution,
  buildValidatorEconomicsHistory,
  rankValidatorEconomics,
  VALIDATOR_ECONOMICS_SORTS,
  groupNeuronsByNetuid,
  type ValidatorEconomicsRow,
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

  // #9460. Shaped like SN5 on 2026-08-05: the owner holds a permit at EXACTLY zero
  // stake, which the top-k-by-stake rule can never reproduce on its own.
  test("grants the subnet owner a permit below the threshold", () => {
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(251, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    assert.deepEqual(
      [...predictPermits(rows, 64, 1000, "5OWNER")].sort(),
      [0, 251],
    );
  });

  test("without an owner hotkey the rule is unchanged", () => {
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(251, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    assert.deepEqual([...predictPermits(rows, 64, 1000)], [0]);
  });

  test("an owner that holds no UID on its own subnet grants nothing", () => {
    const rows = [n(0, { totalStake: 5000, hotkey: "5A" })];
    assert.deepEqual([...predictPermits(rows, 64, 1000, "5ABSENT")], [0]);
  });

  test("the owner's permit comes out of the cap, not on top of it", () => {
    // Two slots, an owner below the threshold, and two eligible competitors: the owner
    // takes one slot, so only the STRONGER competitor gets the other.
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(1, { totalStake: 4000, hotkey: "5B" }),
      n(9, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    assert.deepEqual(
      [...predictPermits(rows, 2, 1000, "5OWNER")].sort(),
      [0, 9],
    );
  });

  test("counts the owner once when it would have ranked in anyway", () => {
    const rows = [
      n(0, { totalStake: 9000, hotkey: "5OWNER" }),
      n(1, { totalStake: 4000, hotkey: "5B" }),
    ];
    assert.deepEqual(
      [...predictPermits(rows, 2, 1000, "5OWNER")].sort(),
      [0, 1],
    );
  });
});

// #9460: the owner exception, measured. On 2026-08-05 thirteen subnets sat below the
// publishable floor; 9 of 9 remaining residuals were the subnet owner and
// over-prediction was 0 on every one of them. Modelling the owner takes all 13 to 1.0
// and moves no other subnet — verified against all 128 live.
describe("modelAgreement with the subnet owner", () => {
  // SN68 on 2026-08-05: 5 observed permits, 4 explicable by stake, the fifth the owner.
  function ownerResidualSubnet(): ValidatorNeuron[] {
    const rows = [
      n(0, { totalStake: 216.6, validatorPermit: true, hotkey: "5OWNER" }),
    ];
    for (let uid = 1; uid < 5; uid += 1)
      rows.push(
        n(uid, {
          totalStake: 2000 + uid,
          validatorPermit: true,
          hotkey: `5V${uid}`,
        }),
      );
    return rows;
  }

  test("an owner-only residual is a permanent, unpublishable disagreement", () => {
    const a = modelAgreement(ownerResidualSubnet(), 64, 1000);
    assert.equal(a.observedPermits, 5);
    assert.equal(a.underPredicted, 1, "the owner");
    assert.equal(a.overPredicted, 0);
    assert.equal(a.agreement, 0.8);
    assert.equal(a.publishable, false);
  });

  test("modelling the owner reproduces the chain exactly", () => {
    const a = modelAgreement(ownerResidualSubnet(), 64, 1000, "5OWNER");
    assert.equal(a.matched, 5);
    assert.equal(a.underPredicted, 0);
    assert.equal(a.overPredicted, 0);
    assert.equal(a.agreement, 1);
    assert.equal(a.publishable, true);
  });

  test("the exception never invents a permit the chain did not grant", () => {
    // An owner registered but NOT permitted on chain must show as over-prediction
    // rather than being quietly matched — the exception has to stay falsifiable.
    const rows = [
      n(0, { totalStake: 5000, validatorPermit: true, hotkey: "5A" }),
      n(1, { totalStake: 0, validatorPermit: false, hotkey: "5OWNER" }),
    ];
    const a = modelAgreement(rows, 64, 1000, "5OWNER");
    assert.equal(a.overPredicted, 1);
    assert.equal(a.matched, 1);
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

  // #9460. The owner's permit is unconditional but still one of `maxValidators`, so it
  // shrinks the field a non-owner competes for. No live subnet has a binding cap today
  // (verified across all 128 on 2026-08-05, where this changes nothing), but where one
  // does, ignoring the owner's seat would report a floor one rank too low.
  test("the owner's seat raises the marginal rank on a capped subnet", () => {
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(1, { totalStake: 4000, hotkey: "5B" }),
      n(2, { totalStake: 3000, hotkey: "5C" }),
      n(9, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    // Three slots, three eligible competitors: without the owner the third slot is the
    // marginal one and the floor is 3000. With the owner holding one, only two slots
    // remain and the marginal competitor is the SECOND — a floor of 4000.
    assert.equal(permitFloorUnits(rows, 3, 1000), 3000);
    assert.equal(permitFloorUnits(rows, 3, 1000, "5OWNER"), 4000);
  });

  test("the owner's seat can make a cap bind that otherwise would not", () => {
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(1, { totalStake: 4000, hotkey: "5B" }),
      n(9, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    assert.equal(capBinding(rows, 3, 1000), false, "2 eligible < 3 slots");
    assert.equal(
      capBinding(rows, 3, 1000, "5OWNER"),
      true,
      "2 competitors for the 2 slots the owner leaves",
    );
  });

  test("a cap the owner alone fills floors at the threshold", () => {
    // One slot, taken by the owner: there is no marginal competitor to read a floor off,
    // so the threshold stands rather than the lookup returning undefined.
    const rows = [
      n(0, { totalStake: 5000, hotkey: "5A" }),
      n(9, { totalStake: 0, hotkey: "5OWNER" }),
    ];
    assert.equal(capBinding(rows, 1, 1000, "5OWNER"), true);
    assert.equal(permitFloorUnits(rows, 1, 1000, "5OWNER"), 1000);
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

  // #9460: which fields the drifted path is allowed to withhold. The floor depends on
  // the model and stays null; these four are counted off the live threshold and the
  // observed permits, so withholding them only forced consumers to guess — and the
  // guess is asymmetric, since assuming an open cap on a full subnet under-reports the
  // floor rather than erring safe.
  test("publishes the fields that need no floor model when the model has drifted", () => {
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
      "the floor still is not published",
    );
    assert.equal(out.capBinding, true, "2 eligible for 2 slots");
    assert.equal(out.uidsAboveThreshold, 2);
    assert.equal(out.validatorSlotsOpen, 0, "max_validators minus permitted");
    assert.equal(
      out.rootTaoToClear,
      1000 / 0.18,
      "threshold / tao_weight is arithmetic, not a model",
    );
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

// #9327: the take distribution. Every assertion here is on a VALUE rather than a
// shape — a median that silently shifts is exactly the kind of wrong answer that
// looks like a right one at the call site.
describe("takeDistribution", () => {
  test("summarises the takes of permit-holders", () => {
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: 0.18 }),
      n(1, { validatorPermit: true, take: 0 }),
      n(2, { validatorPermit: true, take: 0.09 }),
    ]);
    assert.deepEqual(out.distribution, [0, 0.09, 0.18], "ascending");
    assert.equal(out.median, 0.09);
    assert.equal(out.min, 0);
    assert.equal(out.max, 0.18);
    assert.equal(out.sampleSize, 3);
  });

  test("averages the middle pair on an even sample", () => {
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: 0 }),
      n(1, { validatorPermit: true, take: 0.1 }),
      n(2, { validatorPermit: true, take: 0.2 }),
      n(3, { validatorPermit: true, take: 0.3 }),
    ]);
    assert.equal(out.median, 0.15000000000000002);
  });

  test("ignores UIDs that hold no permit", () => {
    // A take set by a UID with no permit is not part of the competitive field.
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: 0.18 }),
      n(1, { validatorPermit: false, take: 0 }),
    ]);
    assert.deepEqual(out.distribution, [0.18]);
    assert.equal(out.sampleSize, 1);
  });

  test("skips a missing take rather than counting it as zero", () => {
    // Counting an absent take as 0 would drag the median toward a floor nobody set.
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: 0.18 }),
      n(1, { validatorPermit: true, take: null }),
      n(2, { validatorPermit: true }),
    ]);
    assert.deepEqual(out.distribution, [0.18]);
    assert.equal(out.median, 0.18);
    assert.equal(out.sampleSize, 1);
  });

  test("skips a non-finite take", () => {
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: Number.NaN }),
      n(1, { validatorPermit: true, take: 0.05 }),
    ]);
    assert.deepEqual(out.distribution, [0.05]);
  });

  test("reports nulls, never zeros, when nobody records a take", () => {
    // A 0 here would read as "everyone validates for free" — the same
    // confident-zero this whole module degrades to avoid.
    const out = takeDistribution([n(0, { validatorPermit: true })]);
    assert.equal(out.median, null);
    assert.equal(out.min, null);
    assert.equal(out.max, null);
    assert.equal(out.medianEarning, null);
    assert.equal(out.sampleSize, 0);
    assert.deepEqual(out.distribution, []);
  });

  test("separates the earning cohort's median from the whole field's", () => {
    // The bimodal case that motivates publishing both: a cohort competing at zero
    // that nobody delegates to, against an earning cohort at the ceiling.
    const out = takeDistribution([
      n(0, { validatorPermit: true, take: 0, dividends: 0 }),
      n(1, { validatorPermit: true, take: 0, dividends: 0 }),
      n(2, { validatorPermit: true, take: 0.18, dividends: 0.5 }),
      n(3, { validatorPermit: true, take: 0.18, dividends: 0.4 }),
    ]);
    assert.equal(out.median, 0.09, "the whole field straddles both modes");
    assert.equal(out.medianEarning, 0.18, "only the earners");
  });
});

describe("buildValidatorEconomics — entry costs, gate and takes (#9323, #9327)", () => {
  const feeBase = {
    maxValidators: 64,
    stakeThreshold: 1000,
    taoWeight: 0.18,
    taoReserve: 1000,
    alphaReserve: 100_000,
  };
  const field = (): ValidatorNeuron[] => [
    n(0, {
      totalStake: 5000,
      validatorPermit: true,
      dividends: 0.5,
      active: true,
      take: 0.18,
    }),
    n(1, {
      totalStake: 2000,
      validatorPermit: true,
      dividends: 0,
      active: true,
      take: 0,
    }),
    n(2, { totalStake: 900 }),
  ];

  test("adds the registration burn to the floor cost", () => {
    // Entry is two spends. 1000 units against a 1000/100k pool costs
    // 1000*1000/(100000-1000) = 10.101..., plus a 2.5 burn.
    const out = buildValidatorEconomics({
      ...feeBase,
      neurons: field(),
      registrationCostTao: 2.5,
    });
    assert.ok(Math.abs((out.permitFloorCostTao ?? 0) - 10.1010101) < 1e-6);
    assert.ok(Math.abs((out.permitEntryCostTao ?? 0) - 12.6010101) < 1e-6);
  });

  test("withholds the entry cost when the burn is unreadable, keeping the floor cost", () => {
    // The burn read is live RPC and allowed to fail. Publishing the floor cost as
    // if it were the entry cost would understate what entry actually costs.
    const out = buildValidatorEconomics({ ...feeBase, neurons: field() });
    assert.ok(out.permitFloorCostTao !== null, "the floor cost is still true");
    assert.equal(out.permitEntryCostTao, null);
    assert.equal(out.earningEntryCostTao, null);
    assert.equal(out.registrationCostTao, null);
  });

  test("reports the permit-to-earning multiple", () => {
    const out = buildValidatorEconomics({ ...feeBase, neurons: field() });
    // Only uid 0 earns, at 5000, against a 1000 floor.
    assert.equal(out.earningFloorUnits, 5000);
    assert.equal(out.permitToEarningMultiple, 5);
  });

  test("counts the eligible UIDs and the open slots", () => {
    const out = buildValidatorEconomics({ ...feeBase, neurons: field() });
    assert.equal(out.uidsAboveThreshold, 2, "uid 2 is below the threshold");
    assert.equal(out.validatorSlotsOpen, 62);
  });

  test("derives the gate state and daily inflow from the per-block emission", () => {
    const out = buildValidatorEconomics({
      ...feeBase,
      neurons: field(),
      taoInEmissionPerBlock: 0.01,
    });
    assert.equal(out.emissionGateOpen, true);
    assert.ok(Math.abs((out.taoInflowPerDay ?? 0) - 72) < 1e-9, "0.01 * 7200");
  });

  test("reports a closed gate as closed, not as unknown", () => {
    const out = buildValidatorEconomics({
      ...feeBase,
      neurons: field(),
      taoInEmissionPerBlock: 0,
    });
    assert.equal(out.emissionGateOpen, false);
    assert.equal(out.taoInflowPerDay, 0);
  });

  test("leaves the gate unknown when the emission was not read", () => {
    // null is not the same as a closed gate, and conflating them would tell an
    // operator a subnet pays nothing when we simply did not look.
    const out = buildValidatorEconomics({ ...feeBase, neurons: field() });
    assert.equal(out.emissionGateOpen, null);
    assert.equal(out.taoInflowPerDay, null);
  });

  test("keeps the gate, burn and takes published on a degraded row", () => {
    // These are READ, not derived — they need no model to be true, so a model
    // failure must not withhold them.
    const out = buildValidatorEconomics({
      ...feeBase,
      neurons: [],
      taoInEmissionPerBlock: 0.01,
      registrationCostTao: 2.5,
      minChildkeyTakeRatio: 0,
    });
    assert.equal(out.degradedReason, "no metagraph rows for this subnet");
    assert.equal(out.emissionGateOpen, true);
    assert.equal(out.registrationCostTao, 2.5);
    assert.equal(out.minChildkeyTakeRatio, 0);
  });

  test("publishes takes even when the permit model has drifted", () => {
    // A drifted model invalidates the derived FLOORS, not the observed takes.
    const drifted = [
      n(0, { totalStake: 10, validatorPermit: true, take: 0.18 }),
      n(1, { totalStake: 20, validatorPermit: true, take: 0.02 }),
      n(2, { totalStake: 5000, validatorPermit: false }),
    ];
    const out = buildValidatorEconomics({ ...feeBase, neurons: drifted });
    assert.ok((out.modelAgreement?.agreement ?? 1) < MIN_PUBLISHABLE_AGREEMENT);
    assert.equal(out.permitFloorUnits, null, "the floor is not publishable");
    assert.equal(out.takes?.sampleSize, 2, "the takes still are");
    assert.ok(Math.abs((out.takes?.median ?? 0) - 0.1) < 1e-12);
  });

  test("passes the childkey take floor straight through", () => {
    const out = buildValidatorEconomics({
      ...feeBase,
      neurons: field(),
      minChildkeyTakeRatio: 0,
    });
    assert.equal(out.minChildkeyTakeRatio, 0);
  });
});

// #9324: the cross-subnet ranking. The assertions are on ORDER and on what was
// EXCLUDED — a ranking that silently drops a subnet is worse than one that is
// merely wrong, because nothing in the output says so.
function row(
  netuid: number,
  over: Partial<ValidatorEconomicsRow> = {},
): ValidatorEconomicsRow {
  return {
    netuid,
    maxValidators: 64,
    permitFloorUnits: 1000,
    permitFloorCostTao: 10,
    permitEntryCostTao: null,
    earningFloorUnits: 5000,
    earningFloorCostTao: 50,
    earningEntryCostTao: null,
    permitToEarningMultiple: 5,
    rootTaoToClear: 5555.5,
    capBinding: false,
    uidsAboveThreshold: 3,
    validatorSlotsOpen: 60,
    composition: { permitted: 4, active: 3, earning: 2 },
    takes: null,
    minChildkeyTakeRatio: null,
    emissionGateOpen: true,
    taoInflowPerDay: 72,
    registrationCostTao: null,
    modelAgreement: null,
    degradedReason: null,
    ...over,
  };
}

describe("rankValidatorEconomics — an unsupported sort", () => {
  // #9460. An unsupported sort silently became the default ranking, which was then
  // echoed back as `sort`. Asking for `tao_inflow_per_day` and mistyping it returned a
  // COST-ranked list, labelled honestly, with no error — a plausible answer to a
  // question nobody asked. REST already returned 400 and GraphQL BAD_USER_INPUT; only
  // MCP reached this, and MCP is where a model's guess lands.
  test("is rejected rather than answered with the default", () => {
    assert.throws(
      () => rankValidatorEconomics([row(1)], { sort: "tao_inflow_per_dya" }),
      (error: Error) => {
        assert.equal(error.name, "UnsupportedSortError");
        assert.match(error.message, /is not a supported sort/);
        // The message names the alternatives — the caller mistyped one of five.
        assert.match(error.message, /tao_inflow_per_day/);
        return true;
      },
    );
  });

  test("an ABSENT sort still takes the default", () => {
    // Not the same question: omitting a sort is a valid request, mistyping one is not.
    for (const options of [{}, { sort: undefined }, { sort: "" }]) {
      assert.equal(
        rankValidatorEconomics([row(1)], options).sort,
        "earning_floor_cost_tao",
      );
    }
  });

  test("every supported key is accepted", () => {
    // Guards the rejection against being too eager as the set changes.
    for (const sort of VALIDATOR_ECONOMICS_SORTS) {
      assert.equal(rankValidatorEconomics([row(1)], { sort }).sort, sort);
    }
  });
});

describe("rankValidatorEconomics", () => {
  test("ranks cheapest-to-earn first by default", () => {
    const out = rankValidatorEconomics([
      row(1, { earningFloorCostTao: 300 }),
      row(2, { earningFloorCostTao: 20 }),
      row(3, { earningFloorCostTao: 100 }),
    ]);
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2, 3, 1],
    );
    assert.equal(out.sort, "earning_floor_cost_tao");
    assert.equal(out.order, "asc");
    assert.equal(out.total, 3);
  });

  test("sorts the more-is-better keys descending", () => {
    const out = rankValidatorEconomics(
      [
        row(1, { taoInflowPerDay: 10 }),
        row(2, { taoInflowPerDay: 500 }),
        row(3, { taoInflowPerDay: 90 }),
      ],
      { sort: "tao_inflow_per_day" },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2, 3, 1],
    );
    assert.equal(out.order, "desc");
  });

  test("ranks by open validator slots when asked for headroom", () => {
    const out = rankValidatorEconomics(
      [row(1, { validatorSlotsOpen: 2 }), row(2, { validatorSlotsOpen: 40 })],
      { sort: "validator_headroom" },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2, 1],
    );
  });

  test("ranks by the permit-to-earning multiple", () => {
    const out = rankValidatorEconomics(
      [
        row(1, { permitToEarningMultiple: 30 }),
        row(2, { permitToEarningMultiple: 2 }),
      ],
      { sort: "permit_to_earning_multiple" },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2, 1],
    );
  });

  test("ranks by the permit floor cost", () => {
    const out = rankValidatorEconomics(
      [row(1, { permitFloorCostTao: 90 }), row(2, { permitFloorCostTao: 3 })],
      { sort: "permit_floor_cost_tao" },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2, 1],
    );
  });

  // Was: "falls back to the default sort rather than erroring on an unknown one",
  // reasoning that the handler rejects a bad sort first so this is only a belt to that
  // braces. The premise was wrong (#9460) — the MCP tool reached here with no
  // validation at all, and the fallback turned a typo into a differently-ranked list
  // presented as an answer. A belt that silently changes the question is worse than no
  // belt; the rejection now lives here, where every surface passes through.
  // Behaviour pinned in "rankValidatorEconomics — an unsupported sort" above.

  test("excludes an unpriceable subnet with a reason instead of ranking it first", () => {
    // A null cost sorted as 0 would put the one subnet we CANNOT price at the
    // top of a list titled "cheapest".
    const out = rankValidatorEconomics([
      row(1, { earningFloorCostTao: null }),
      row(2, { earningFloorCostTao: 50 }),
    ]);
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2],
    );
    assert.deepEqual(out.excluded, [
      { netuid: 1, reason: "earning_floor_cost_tao is unavailable" },
    ]);
    assert.equal(out.total, 1, "total counts what survived the filters");
  });

  test("filters on the emission gate, and says which subnets that dropped", () => {
    const out = rankValidatorEconomics(
      [row(1, { emissionGateOpen: false }), row(2, { emissionGateOpen: true })],
      { emissionGateOpen: true },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [2],
    );
    assert.deepEqual(out.excluded, [
      { netuid: 1, reason: "emission_gate_open is false" },
    ]);
  });

  test("an absent gate filter means BOTH, not false", () => {
    // The tri-state matters: a closed gate is a candidate, not a disqualifier —
    // those subnets are less contested and pay more per unit of stake.
    const out = rankValidatorEconomics([
      row(1, { emissionGateOpen: false }),
      row(2, { emissionGateOpen: true }),
    ]);
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.excluded, []);
  });

  test("filters on cap_binding", () => {
    const out = rankValidatorEconomics(
      [row(1, { capBinding: true }), row(2, { capBinding: false })],
      { capBinding: true },
    );
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [1],
    );
    assert.deepEqual(out.excluded, [
      { netuid: 2, reason: "cap_binding is false" },
    ]);
  });

  test("breaks ties by netuid so paging is stable across runs", () => {
    // Without this, offset pagination silently drops or repeats rows between
    // two requests against identical chain state.
    const out = rankValidatorEconomics([
      row(9, { earningFloorCostTao: 10 }),
      row(3, { earningFloorCostTao: 10 }),
      row(6, { earningFloorCostTao: 10 }),
    ]);
    assert.deepEqual(
      out.rows.map((r) => r.netuid),
      [3, 6, 9],
    );
  });

  test("pages with limit and offset over the ranked order", () => {
    const rows = [10, 20, 30, 40, 50].map((cost, i) =>
      row(i + 1, { earningFloorCostTao: cost }),
    );
    const page = rankValidatorEconomics(rows, { limit: 2, offset: 2 });
    assert.deepEqual(
      page.rows.map((r) => r.netuid),
      [3, 4],
    );
    assert.equal(page.total, 5, "total is the match count, not the page size");
  });

  test("a negative offset is clamped rather than wrapping the slice", () => {
    const out = rankValidatorEconomics([row(1), row(2)], { offset: -5 });
    assert.equal(out.rows.length, 2);
  });

  test("an empty input ranks to an empty list, not an error", () => {
    const out = rankValidatorEconomics([]);
    assert.deepEqual(out.rows, []);
    assert.equal(out.total, 0);
  });
});

describe("groupNeuronsByNetuid", () => {
  test("buckets one flat cross-subnet scan by netuid", () => {
    const grouped = groupNeuronsByNetuid([
      { netuid: 5, ...n(0, { totalStake: 100 }) },
      { netuid: 7, ...n(0, { totalStake: 200 }) },
      { netuid: 5, ...n(1, { totalStake: 300 }) },
    ]);
    assert.deepEqual([...grouped.keys()], [5, 7]);
    assert.equal(grouped.get(5)?.length, 2);
    assert.equal(grouped.get(7)?.length, 1);
    assert.equal(grouped.get(5)?.[1].totalStake, 300);
  });

  test("carries the take through so the distribution survives grouping", () => {
    const grouped = groupNeuronsByNetuid([
      { netuid: 5, ...n(0, { validatorPermit: true, take: 0.18 }) },
    ]);
    assert.equal(grouped.get(5)?.[0].take, 0.18);
  });

  // The rebuild names every field explicitly, so a new one is dropped unless it is
  // added there too — which would leave the owner exception working on the per-subnet
  // route and silently disabled on the cross-subnet ranking (#9460).
  test("carries the hotkey through so the owner exception survives grouping", () => {
    const grouped = groupNeuronsByNetuid([
      { netuid: 5, ...n(0, { hotkey: "5OWNER" }) },
    ]);
    assert.equal(grouped.get(5)?.[0].hotkey, "5OWNER");
  });

  test("a neuron scanned without a hotkey groups to an explicit null", () => {
    const grouped = groupNeuronsByNetuid([{ netuid: 5, ...n(0) }]);
    assert.equal(grouped.get(5)?.[0].hotkey, null);
  });

  test("an empty scan groups to an empty map", () => {
    assert.equal(groupNeuronsByNetuid([]).size, 0);
  });
});

// #9326: the history series. The floors here are OBSERVED off each snapshot, and
// the tests pin that explicitly — re-deriving them from today's sudo-settable
// threshold would show a flat line across a governance change that moved the floor.
describe("buildValidatorEconomicsHistory", () => {
  const day = (snapshot_date: string, over: Record<string, unknown> = {}) => ({
    snapshot_date,
    stake_tao: 5000,
    validator_permit: 1,
    dividends: 0.5,
    active: 1,
    ...over,
  });

  test("folds per-UID rows into one point per day, newest first", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01"),
      day("2026-08-01", { stake_tao: 3000 }),
      day("2026-08-02"),
    ]);
    assert.deepEqual(
      points.map((p) => p.snapshot_date),
      ["2026-08-02", "2026-08-01"],
    );
    assert.equal(points[1].validators_permitted, 2);
  });

  // #9460. `permit_floor_alpha` is the observed floor regardless of cap state, so a
  // consumer has to test the cap per day to use it — and the cap was not in the point.
  // Joining today's cap from the current record is silently wrong for any subnet whose
  // cap moved inside the window.
  test("carries the cap on every point so the floor is interpretable alone", () => {
    const points = buildValidatorEconomicsHistory(
      [day("2026-08-01"), day("2026-08-02")],
      [],
      { maxValidators: 64 },
    );
    assert.deepEqual(
      points.map((p) => p.max_validators),
      [64, 64],
    );
  });

  test("an unknown cap is null on every point, never zero", () => {
    // A 0 here would read as "no validator slots at all".
    const points = buildValidatorEconomicsHistory([day("2026-08-01")]);
    assert.equal(points[0].max_validators, null);
    assert.equal(points[0].max_validators_source, null);
    assert.equal(points[0].permit_set_full, null);
  });

  // The change-log is what makes the cap publishable per day. Re-running today's cap
  // over an old snapshot would show a flat cap across a change that really happened —
  // the same class of error the module refuses for the floor.
  test("reads the cap in force on each day from the change-log", () => {
    const capHistory = [
      { observed_at: Date.parse("2026-08-02T12:00:00Z"), max_validators: 64 },
      { observed_at: Date.parse("2026-07-01T00:00:00Z"), max_validators: 8 },
    ];
    const points = buildValidatorEconomicsHistory(
      [day("2026-08-01"), day("2026-08-03")],
      [],
      { capHistory, maxValidators: 64 },
    );
    const byDate = new Map(points.map((p) => [p.snapshot_date, p]));
    assert.equal(
      byDate.get("2026-08-01")?.max_validators,
      8,
      "before the raise",
    );
    assert.equal(byDate.get("2026-08-03")?.max_validators, 64, "after it");
    assert.equal(byDate.get("2026-08-01")?.max_validators_source, "observed");
  });

  test("a change landing mid-day counts for that day", () => {
    // Permits are recomputed across the day, so the cap at its END is the one that
    // day's set was computed against.
    const points = buildValidatorEconomicsHistory([day("2026-08-02")], [], {
      capHistory: [
        { observed_at: Date.parse("2026-08-02T12:00:00Z"), max_validators: 64 },
      ],
    });
    assert.equal(points[0].max_validators, 64);
    assert.equal(points[0].max_validators_source, "observed");
  });

  test("falls back to the live cap for days the change-log predates", () => {
    const points = buildValidatorEconomicsHistory([day("2026-06-01")], [], {
      capHistory: [
        { observed_at: Date.parse("2026-08-02T00:00:00Z"), max_validators: 64 },
      ],
      maxValidators: 32,
    });
    assert.equal(points[0].max_validators, 32);
    assert.equal(
      points[0].max_validators_source,
      "current",
      "an approximation the consumer can see is not an approximation that misleads",
    );
  });

  test("ignores change-log entries that record no cap", () => {
    // The table logs every hyperparameter, so most rows carry no max_validators.
    const points = buildValidatorEconomicsHistory([day("2026-08-03")], [], {
      capHistory: [
        {
          observed_at: Date.parse("2026-08-01T00:00:00Z"),
          max_validators: null,
        },
      ],
      maxValidators: 16,
    });
    assert.equal(points[0].max_validators, 16);
    assert.equal(points[0].max_validators_source, "current");
  });

  test("a non-positive cap is treated as unknown", () => {
    const points = buildValidatorEconomicsHistory([day("2026-08-01")], [], {
      maxValidators: 0,
    });
    assert.equal(points[0].max_validators, null);
  });

  test("permit_set_full compares the permitted count against the cap", () => {
    const rows = [
      day("2026-08-01", { stake_tao: 9000 }),
      day("2026-08-01", { stake_tao: 8000 }),
    ];
    assert.equal(
      buildValidatorEconomicsHistory(rows, [], { maxValidators: 2 })[0]
        .permit_set_full,
      true,
    );
    assert.equal(
      buildValidatorEconomicsHistory(rows, [], { maxValidators: 3 })[0]
        .permit_set_full,
      false,
    );
  });

  // The per-subnet record fails closed when it cannot justify a floor. The series did
  // not, so a subnet whose owner holds a permit at ~0 published `permit_floor_alpha: 0`
  // — "free to validate", the exact wrong answer the rest of the module avoids.
  test("the owner's unconditional permit never sets the floor", () => {
    const rows = [
      day("2026-08-01", { stake_tao: 4000, hotkey: "5V0" }),
      day("2026-08-01", { stake_tao: 0, hotkey: "5OWNER" }),
    ];
    assert.equal(
      buildValidatorEconomicsHistory(rows)[0].permit_floor_alpha,
      0,
      "without an owner the observed minimum is the owner's zero",
    );
    const fixed = buildValidatorEconomicsHistory(rows, [], {
      ownerHotkey: "5OWNER",
    })[0];
    assert.equal(fixed.permit_floor_alpha, 4000);
    assert.equal(
      fixed.validators_permitted,
      2,
      "the owner still counts as permitted — that is observed truth",
    );
  });

  test("the owner is excluded from the earning floor too", () => {
    const rows = [
      day("2026-08-01", { stake_tao: 4000, hotkey: "5V0", dividends: 0.5 }),
      day("2026-08-01", { stake_tao: 1, hotkey: "5OWNER", dividends: 0.9 }),
    ];
    const p = buildValidatorEconomicsHistory(rows, [], {
      ownerHotkey: "5OWNER",
    })[0];
    assert.equal(p.earning_floor_alpha, 4000);
    assert.equal(p.validators_earning, 2, "still counted, just not a floor");
  });

  test("a row with no hotkey is never mistaken for the owner", () => {
    const rows = [day("2026-08-01", { stake_tao: 7 })];
    const p = buildValidatorEconomicsHistory(rows, [], {
      ownerHotkey: "5OWNER",
    })[0];
    assert.equal(p.permit_floor_alpha, 7);
  });

  test("the permit floor is the smallest stake that ACTUALLY held a permit", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: 9000 }),
      day("2026-08-01", { stake_tao: 1200 }),
      // Below both, but holds no permit — it says nothing about what holding one
      // required, so it must not drag the floor down.
      day("2026-08-01", { stake_tao: 5, validator_permit: 0 }),
    ]);
    assert.equal(points[0].permit_floor_alpha, 1200);
  });

  test("the earning floor only counts permit-holders that earned", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: 9000, dividends: 0.5 }),
      day("2026-08-01", { stake_tao: 2000, dividends: 0 }),
    ]);
    assert.equal(points[0].permit_floor_alpha, 2000);
    assert.equal(
      points[0].earning_floor_alpha,
      9000,
      "the earner, not the cheaper",
    );
    assert.equal(points[0].validators_earning, 1);
  });

  test("a day where nobody earned reports a null earning floor, not a zero", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { dividends: 0 }),
    ]);
    assert.equal(points[0].earning_floor_alpha, null);
    assert.equal(points[0].permit_floor_alpha, 5000);
  });

  test("a day with no permit-holders at all has no floor", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { validator_permit: 0 }),
    ]);
    assert.equal(points[0].permit_floor_alpha, null);
    assert.equal(points[0].validators_permitted, 0);
  });

  test("counts permitted, active and earning separately per day", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { active: 1, dividends: 0.5 }),
      day("2026-08-01", { active: 1, dividends: 0 }),
      day("2026-08-01", { active: 0, dividends: 0 }),
    ]);
    assert.equal(points[0].validators_permitted, 3);
    assert.equal(points[0].validators_active, 2);
    assert.equal(points[0].validators_earning, 1);
  });

  test("joins the emission series to derive the gate and daily inflow", () => {
    const points = buildValidatorEconomicsHistory(
      [day("2026-08-01"), day("2026-08-02")],
      [
        { snapshot_date: "2026-08-01", tao_in_emission_tao: 0.01 },
        { snapshot_date: "2026-08-02", tao_in_emission_tao: 0 },
      ],
    );
    const [aug2, aug1] = points;
    assert.equal(aug1.emission_gate_open, true);
    assert.ok(Math.abs((aug1.tao_inflow_per_day ?? 0) - 72) < 1e-9);
    assert.equal(
      aug2.emission_gate_open,
      false,
      "a gate CLOSE is the transition",
    );
    assert.equal(aug2.tao_inflow_per_day, 0);
  });

  test("a day with no emission row is unknown, not closed", () => {
    const points = buildValidatorEconomicsHistory([day("2026-08-01")], []);
    assert.equal(points[0].emission_gate_open, null);
    assert.equal(points[0].tao_inflow_per_day, null);
  });

  test("a null emission value is unknown rather than a closed gate", () => {
    const points = buildValidatorEconomicsHistory(
      [day("2026-08-01")],
      [{ snapshot_date: "2026-08-01", tao_in_emission_tao: null }],
    );
    assert.equal(points[0].emission_gate_open, null);
  });

  test("keeps a day the neuron snapshot missed but the emission series recorded", () => {
    // A gate close on a day with no neuron rows is exactly the transition this
    // series exists to make visible; dropping it would hide it.
    const points = buildValidatorEconomicsHistory(
      [day("2026-08-01")],
      [
        { snapshot_date: "2026-08-01", tao_in_emission_tao: 0.01 },
        { snapshot_date: "2026-08-02", tao_in_emission_tao: 0 },
      ],
    );
    assert.equal(points.length, 2);
    assert.equal(points[0].snapshot_date, "2026-08-02");
    assert.equal(points[0].validators_permitted, 0);
    assert.equal(points[0].emission_gate_open, false);
  });

  test("the earning floor is order-independent within a day", () => {
    // Row order is not guaranteed, so the floor has to be the minimum either way:
    // a cheaper earner arriving late must lower it, and a dearer one arriving
    // late must NOT raise it.
    const descending = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: 9000, dividends: 0.5 }),
      day("2026-08-01", { stake_tao: 2500, dividends: 0.5 }),
    ]);
    assert.equal(descending[0].earning_floor_alpha, 2500);

    const ascending = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: 2500, dividends: 0.5 }),
      day("2026-08-01", { stake_tao: 9000, dividends: 0.5 }),
    ]);
    assert.equal(
      ascending[0].earning_floor_alpha,
      2500,
      "a dearer earner must not raise the floor",
    );
  });

  test("coerces a non-numeric stake to zero rather than propagating NaN", () => {
    // A NaN floor would compare false against everything and silently vanish
    // from the series rather than failing loudly.
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: "not-a-number" }),
    ]);
    assert.equal(points[0].permit_floor_alpha, 0);
  });

  test("an empty read yields an empty series, not an error", () => {
    assert.deepEqual(buildValidatorEconomicsHistory([]), []);
  });

  test("coerces non-numeric stake to zero rather than propagating NaN", () => {
    const points = buildValidatorEconomicsHistory([
      day("2026-08-01", { stake_tao: null }),
    ]);
    assert.equal(points[0].permit_floor_alpha, 0);
  });
});
