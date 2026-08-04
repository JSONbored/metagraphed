// Validator entry economics: what a validator permit costs on a subnet, and
// whether holding one actually earns. Pure functions over a subnet's per-UID stake,
// permit and dividend columns plus its pool reserves — no D1, no RPC, so every branch
// is unit-testable and the Worker handler stays a thin read + envelope.
//
// ## The rule, read from subtensor v441 (the deployed runtime), not inferred
//
//   validator_permit = top max_validators by total_stake,
//                      among UIDs with total_stake >= StakeThreshold
//
//   total_stake = alpha + tao_weight * root      <- RAW rao, NOT normalised per leg
//
// `staking/stake_utils.rs:278` combines the legs; `epoch/run_epoch.rs:246-261` filters
// on the result then takes `is_topk_nonzero`. `StakeThreshold` raw is
// 0x0010a5d4e8000000 = 1e12 rao = 1,000 units. `tao_weight` = TaoWeight::get()/u64::MAX
// = 0.18. Both are sudo-settable, so callers read them live and pass them in.
//
// ## Why this module takes `totalStake` and never the separate legs
//
// The RPC metagraph's `total_stake` field is produced by the SAME
// `get_stake_weights_for_network` call the epoch uses for permits
// (`rpc_info/metagraph.rs:685`). Our published `stake_tao` IS that field — it already
// contains the root leg. Reconstructing it from alpha + root double-counts, which is
// exactly the bug this module previously shipped (#9331): it manufactured 42 apparent
// counterexamples of root stake failing to buy a permit, all of which are consistent
// once the double-count is removed. Taking `totalStake` directly removes the bug class.
//
// Verified against every UID on every subnet with an open validator cap on 2026-08-03:
// `totalStake >= 1000` predicts the observed permit with 99.96% accuracy (1,448/1,450).
//
// ## Consequence worth stating plainly
//
// Root stake is not split — the same balance counts on every subnet the hotkey is
// registered on. So `StakeThreshold / tao_weight` (currently 5,556 TAO) clears the gate
// network-wide with zero alpha. `rootTaoToClear` exposes that.
//
// ## Two refusals, each a wrong answer found while measuring
//
//  1. `stakeThreshold` and `taoWeight` are PARAMETERS, never constants. A module that
//     bakes in 1000 / 0.18 keeps returning confident, wrong floors after a governance
//     change with nothing anywhere to notice.
//  2. Rewards accrue as alpha. Realised revenue must go through `ammProceedsTao` — a
//     spot mark overstates, because selling drains the pool it is priced against.

/** One UID's economics, normalised away from any tier's column shape. */
export type ValidatorNeuron = {
  uid: number;
  /**
   * The metagraph's `total_stake` / our `stake_tao` — ALREADY `alpha + tao_weight * root`.
   * This is the quantity the threshold tests. Never reconstruct it from separate legs.
   */
  totalStake: number;
  validatorPermit: boolean;
  dividends: number;
  active: boolean;
};

/** How far `modelAgreement` may fall before a derived floor stops being publishable. */
export const MIN_PUBLISHABLE_AGREEMENT = 0.95;

export type ModelAgreement = {
  matched: number;
  overPredicted: number;
  underPredicted: number;
  observedPermits: number;
  /** null when the subnet granted no permits at all — no denominator to score against. */
  agreement: number | null;
  publishable: boolean;
};

export type SetComposition = {
  permitted: number;
  active: number;
  earning: number;
};

export type ValidatorEconomics = {
  permitFloorUnits: number | null;
  permitFloorCostTao: number | null;
  earningFloorUnits: number | null;
  earningFloorCostTao: number | null;
  rootTaoToClear: number | null;
  capBinding: boolean | null;
  composition: SetComposition | null;
  modelAgreement: ModelAgreement | null;
  /** Non-null whenever a field above was withheld, naming which input was missing. */
  degradedReason: string | null;
};

// TAO required to BUY `alphaAmount` out of a constant-product pool.
//
// null when the pool cannot serve the trade rather than a misleading number: a subnet
// whose pool cannot price the trade is not a cheap subnet, and a `0` would read as
// "free to validate".
export function ammCostTao(
  taoReserve: number,
  alphaReserve: number,
  alphaAmount: number,
): number | null {
  if (!Number.isFinite(taoReserve) || !Number.isFinite(alphaReserve))
    return null;
  if (!Number.isFinite(alphaAmount)) return null;
  if (taoReserve <= 0 || alphaReserve <= 0) return null;
  // At or beyond the whole alpha side the constant-product price diverges.
  if (alphaAmount <= 0 || alphaAmount >= alphaReserve) return null;
  return (taoReserve * alphaAmount) / (alphaReserve - alphaAmount);
}

// TAO received for SELLING alpha into the pool — how rewards become cash.
//
// Asymmetric with the buy: selling adds alpha to the pool and drains TAO from it, so
// proceeds are strictly below the spot mark. Every realised-revenue figure goes through
// here; quoting reward value at spot overstates it.
export function ammProceedsTao(
  taoReserve: number,
  alphaReserve: number,
  alphaAmount: number,
): number | null {
  if (!Number.isFinite(taoReserve) || !Number.isFinite(alphaReserve))
    return null;
  if (!Number.isFinite(alphaAmount)) return null;
  if (taoReserve <= 0 || alphaReserve <= 0 || alphaAmount <= 0) return null;
  return (taoReserve * alphaAmount) / (alphaReserve + alphaAmount);
}

// Instantaneous TAO-per-alpha from reserves. A mark, never a trade cost.
export function spotPriceTao(
  taoReserve: number,
  alphaReserve: number,
): number | null {
  if (!Number.isFinite(taoReserve) || !Number.isFinite(alphaReserve))
    return null;
  if (alphaReserve <= 0) return null;
  return taoReserve / alphaReserve;
}

// Root stake that clears the threshold on EVERY subnet at once.
//
// Root is not split: `get_tao_inherited_for_hotkey_on_subnet` reads the same root
// balance for every netuid, adjusted only for childkey allocations on that subnet. At
// the 2026-08-03 values (1,000 / 0.18) this is 5,556 TAO.
export function rootTaoToClear(
  stakeThreshold: number,
  taoWeight: number,
): number | null {
  if (!Number.isFinite(stakeThreshold) || !Number.isFinite(taoWeight))
    return null;
  if (taoWeight <= 0) return null;
  return stakeThreshold / taoWeight;
}

// UIDs clearing the threshold. Tests `totalStake`, which already includes the root leg.
export function eligible(
  neurons: readonly ValidatorNeuron[],
  stakeThreshold: number,
): ValidatorNeuron[] {
  return neurons.filter((n) => n.totalStake >= stakeThreshold);
}

// Eligible neurons ranked by total stake, ties broken by uid so the set is deterministic.
function ranked(
  neurons: readonly ValidatorNeuron[],
  stakeThreshold: number,
): ValidatorNeuron[] {
  return eligible(neurons, stakeThreshold).sort((a, b) =>
    b.totalStake - a.totalStake !== 0
      ? b.totalStake - a.totalStake
      : a.uid - b.uid,
  );
}

// The permit set the rule implies: top-k by total stake among those clearing the threshold.
export function predictPermits(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
): Set<number> {
  const predicted = new Set<number>();
  for (const n of ranked(neurons, stakeThreshold).slice(0, maxValidators)) {
    // A zero-stake UID clears the threshold only if the threshold is itself zero, which
    // a governance change could do — do not claim a permit in that case.
    if (n.totalStake > 0) predicted.add(n.uid);
  }
  return predicted;
}

// How well the rule reproduces the permits the chain actually granted.
//
// The rule is read from source, but `StakeThreshold` is sudo-settable and a serving tier
// can be stale, so a caller that reports a floor without reporting this is asserting a
// confidence it has not earned. Over- and under-prediction are separate because recall
// alone flatters a model that says yes too often.
export function modelAgreement(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
): ModelAgreement {
  const predicted = predictPermits(neurons, maxValidators, stakeThreshold);
  const observed = new Set<number>();
  for (const n of neurons) if (n.validatorPermit) observed.add(n.uid);

  let matched = 0;
  for (const uid of predicted) if (observed.has(uid)) matched += 1;
  const agreement = observed.size > 0 ? matched / observed.size : null;
  return {
    matched,
    overPredicted: predicted.size - matched,
    underPredicted: observed.size - matched,
    observedPermits: observed.size,
    agreement,
    // A subnet with no permits yet is not evidence of drift, so it stays publishable.
    publishable: agreement === null || agreement >= MIN_PUBLISHABLE_AGREEMENT,
  };
}

// True when more UIDs clear the threshold than there are validator slots.
//
// Decides WHICH floor applies. Where the cap is not full — 127 of 128 subnets on
// 2026-08-03 — the floor is the threshold itself, and extra stake buys no additional
// claim on a permit (though it still buys dividend share).
export function capBinding(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
): boolean {
  return eligible(neurons, stakeThreshold).length >= maxValidators;
}

// Total-stake units needed to hold a permit on this subnet.
export function permitFloorUnits(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
): number {
  if (!capBinding(neurons, maxValidators, stakeThreshold))
    return stakeThreshold;
  const marginal = ranked(neurons, stakeThreshold)[maxValidators - 1];
  return Math.max(stakeThreshold, marginal.totalStake);
}

// Total stake held by the smallest permit-holder actually earning dividends.
//
// Descriptive, not a rule — there is no chain threshold at this level, and earning also
// requires submitting weights each epoch. Of ACTIVE permit-holders 97.8% earn; of
// INACTIVE ones 1.3% do. Reported beside the floor, never instead of it. Null when
// nobody on the subnet earns.
export function earningFloorUnits(
  neurons: readonly ValidatorNeuron[],
): number | null {
  let floor: number | null = null;
  for (const n of neurons) {
    if (!n.validatorPermit || n.dividends <= 0) continue;
    if (floor === null || n.totalStake < floor) floor = n.totalStake;
  }
  return floor;
}

// Permitted / active / earning are three different sets and the gaps are large:
// 1,523 / 1,137 / 1,117 network-wide on 2026-08-03, and 64 / 8 / 7 on SN83. A single
// "validator count" is wrong three ways, so all three are always reported together.
export function setComposition(
  neurons: readonly ValidatorNeuron[],
): SetComposition {
  let permitted = 0;
  let active = 0;
  let earning = 0;
  for (const n of neurons) {
    if (!n.validatorPermit) continue;
    permitted += 1;
    if (n.active) active += 1;
    if (n.dividends > 0) earning += 1;
  }
  return { permitted, active, earning };
}

// Sum of total stake over UIDs clearing the threshold — the dividend denominator.
export function subnetStakeTotal(
  neurons: readonly ValidatorNeuron[],
  stakeThreshold: number,
): number {
  let total = 0;
  for (const n of eligible(neurons, stakeThreshold)) total += n.totalStake;
  return total;
}

// Our dividend share if we hold `ourUnits` of total stake on this subnet.
export function shareOfSubnet(
  neurons: readonly ValidatorNeuron[],
  ourUnits: number,
  stakeThreshold: number,
): number {
  if (ourUnits < stakeThreshold) return 0;
  const denom = subnetStakeTotal(neurons, stakeThreshold) + ourUnits;
  return denom > 0 ? ourUnits / denom : 0;
}

/** Inputs a caller must supply; each is read live rather than assumed. */
export type EconomicsInputs = {
  neurons: readonly ValidatorNeuron[];
  maxValidators: number | null;
  /** SubtensorModule.StakeThreshold, read live. Sudo-settable — never a constant. */
  stakeThreshold: number | null;
  /** SubtensorModule.TaoWeight, read live. Sudo-settable — never a constant. */
  taoWeight: number | null;
  taoReserve: number | null;
  alphaReserve: number | null;
};

// Compose the published shape, degrading rather than guessing.
//
// Every path that cannot produce a trustworthy number returns nulls plus a
// `degradedReason` naming the missing input. A confident `0` here would read as "free to
// validate" — the same class of bug as #9285 / #9114, where an absent reader was served
// as fact.
export function buildValidatorEconomics(
  inputs: EconomicsInputs,
): ValidatorEconomics {
  const blank: ValidatorEconomics = {
    permitFloorUnits: null,
    permitFloorCostTao: null,
    earningFloorUnits: null,
    earningFloorCostTao: null,
    rootTaoToClear: null,
    capBinding: null,
    composition: null,
    modelAgreement: null,
    degradedReason: null,
  };

  const { neurons, maxValidators, stakeThreshold, taoWeight } = inputs;
  if (stakeThreshold === null || taoWeight === null) {
    return { ...blank, degradedReason: "chain parameters unavailable" };
  }
  if (maxValidators === null || maxValidators <= 0) {
    return { ...blank, degradedReason: "max_validators unavailable" };
  }
  if (neurons.length === 0) {
    return { ...blank, degradedReason: "no metagraph rows for this subnet" };
  }

  const agreement = modelAgreement(neurons, maxValidators, stakeThreshold);
  const composition = setComposition(neurons);
  // Composition and agreement are OBSERVED, not derived — they stay published even when
  // the model has drifted, because they are exactly what a caller needs to see why.
  if (!agreement.publishable) {
    return {
      ...blank,
      composition,
      modelAgreement: agreement,
      degradedReason:
        "permit model disagrees with observed permits on this subnet",
    };
  }

  const floor = permitFloorUnits(neurons, maxValidators, stakeThreshold);
  const earnFloor = earningFloorUnits(neurons);
  const floorCost = ammCostTao(
    inputs.taoReserve ?? NaN,
    inputs.alphaReserve ?? NaN,
    floor,
  );
  const earnCost =
    earnFloor === null
      ? null
      : ammCostTao(
          inputs.taoReserve ?? NaN,
          inputs.alphaReserve ?? NaN,
          earnFloor,
        );

  return {
    permitFloorUnits: floor,
    permitFloorCostTao: floorCost,
    earningFloorUnits: earnFloor,
    earningFloorCostTao: earnCost,
    rootTaoToClear: rootTaoToClear(stakeThreshold, taoWeight),
    capBinding: capBinding(neurons, maxValidators, stakeThreshold),
    composition,
    modelAgreement: agreement,
    // Reserves missing is a partial degrade: the unit floors are still true, only their
    // TAO cost is unknown. Say so rather than implying the whole row is bad.
    degradedReason:
      floorCost === null ? "pool reserves unavailable — costs withheld" : null,
  };
}
