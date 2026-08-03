// Validator entry economics: what a validator permit costs on a subnet, and
// whether holding one actually earns. Pure functions over a subnet's per-UID
// stake/permit/dividend columns plus its pool reserves — no D1, no RPC, so every
// branch is unit-testable and the Worker handler stays a thin read + envelope.
//
// This is the derivation half of #9322. It deliberately ships BEFORE any route
// that publishes its output, because the rule it models is inferred rather than
// read from the subtensor runtime, and `modelAgreement` is what licenses
// publishing a floor at all (#9325).
//
// ## The rule
//
//   validator_permit = (top max_validators by stake weight) AND (alpha >= StakeThreshold)
//
// where stake weight is `alphaShare + taoWeight * rootShare`, each leg normalised
// across the subnet before combining. That normalisation is why root stake behaves
// as a SHARE of a fixed pool rather than an absolute quantity, and why it saturates.
//
// ## Why the rule is treated as provisional
//
// Measured against finney on 2026-08-03 this conjunction reproduced 1,512 of 1,523
// observed permits (agreement 0.9928): 2 over-predictions, 11 under-predictions. All
// 11 misses sit BELOW the threshold — 8 between 1 and 1,000 alpha, 3 at exactly zero
// alpha with zero total stake — which reads as permits not yet recomputed, since a
// permit persists until the next epoch. Unconfirmed.
//
// A looser model that ranks by stake weight WITHOUT the threshold filter scores higher
// recall by over-predicting 3,270 UIDs, 3,269 of them below the threshold. That is what
// established the floor exists; it is not evidence this rule is right. Recall alone
// flatters a model that says yes too often, which is why `modelAgreement` reports
// over- and under-prediction separately rather than a single score.
//
// ## Three refusals, each one a wrong answer found while measuring
//
//  1. `stakeThresholdAlpha` and `taoWeight` are PARAMETERS, never constants. Both are
//     sudo-settable on chain. A module that bakes in 1000 / 0.18 keeps returning
//     confident, wrong floors after a runtime change with nothing anywhere to notice.
//  2. Cost is constant-product execution against real pool reserves for the actual
//     size — never a quoted price. The published `alpha_price_tao` is a moving/EMA
//     price and diverges from reserves on 47 of 128 subnets, by up to 275% on stalled
//     ones.
//  3. Alpha and TAO are different units and are never summed. A non-root neuron's
//     stake is that subnet's alpha token — see docs/tao-alpha-denomination.md.

/** One UID's economics, normalised away from any tier's column shape. */
export type ValidatorNeuron = {
  uid: number;
  /** That subnet's alpha, NOT tao — the chain's own denomination for netuid != 0. */
  alphaStake: number;
  /** The hotkey's netuid-0 stake, in genuine TAO. Zero when it holds none. */
  rootStake: number;
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
  permitFloorAlpha: number | null;
  permitEntryCostTao: number | null;
  earningFloorAlpha: number | null;
  earningEntryCostTao: number | null;
  capBinding: boolean | null;
  composition: SetComposition | null;
  modelAgreement: ModelAgreement | null;
  /** Non-null whenever a field above was withheld, naming which input was missing. */
  degradedReason: string | null;
};

// TAO required to buy `alphaAmount` out of a constant-product pool.
//
// Returns null when the pool cannot serve the trade rather than a misleading number:
// a subnet whose pool cannot price the trade is not a cheap subnet, it is an
// unpriceable one, and a `0` here would read as "free to validate".
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

// Instantaneous TAO-per-alpha from reserves. A mark, never a trade cost — the
// distinction that made 47 of 128 subnets misprice when an EMA stood in for it.
export function spotPriceTao(
  taoReserve: number,
  alphaReserve: number,
): number | null {
  if (!Number.isFinite(taoReserve) || !Number.isFinite(alphaReserve))
    return null;
  if (alphaReserve <= 0) return null;
  return taoReserve / alphaReserve;
}

type Weighted = { neuron: ValidatorNeuron; weight: number };

// Neurons paired with their stake weight, in one pass.
//
// The ranking paths below consume this array rather than looking weights up by uid.
// A Map lookup would force a `?? 0` fallback on every read that can never fire —
// unreachable branches that the 99% patch gate counts against us, and which would have
// to be either ignored or faked into coverage. Not having them is simpler than either.
function weighted(
  neurons: readonly ValidatorNeuron[],
  taoWeight: number,
): Weighted[] {
  let totalAlpha = 0;
  let totalRoot = 0;
  for (const n of neurons) {
    totalAlpha += n.alphaStake;
    totalRoot += n.rootStake;
  }
  return neurons.map((neuron) => {
    const alphaLeg = totalAlpha > 0 ? neuron.alphaStake / totalAlpha : 0;
    const rootLeg = totalRoot > 0 ? neuron.rootStake / totalRoot : 0;
    return { neuron, weight: alphaLeg + taoWeight * rootLeg };
  });
}

// Eligible neurons ranked by stake weight, descending, ties broken by uid so the
// resulting set is deterministic across runs.
function rankedEligible(
  neurons: readonly ValidatorNeuron[],
  stakeThresholdAlpha: number,
  taoWeight: number,
): Weighted[] {
  return weighted(neurons, taoWeight)
    .filter((w) => w.neuron.alphaStake >= stakeThresholdAlpha)
    .sort((a, b) =>
      b.weight - a.weight !== 0
        ? b.weight - a.weight
        : a.neuron.uid - b.neuron.uid,
    );
}

// Per-UID stake weight, keyed by uid. Each leg normalised before combining.
export function stakeWeights(
  neurons: readonly ValidatorNeuron[],
  taoWeight: number,
): Map<number, number> {
  return new Map(
    weighted(neurons, taoWeight).map((w) => [w.neuron.uid, w.weight]),
  );
}

// UIDs clearing the alpha floor. Below it rank is irrelevant and no amount of root
// stake substitutes — a holder with 204,767 TAO of root was excluded on the two
// subnets where its alpha was 942.0 and 945.0, against a threshold of 1,000.
export function eligible(
  neurons: readonly ValidatorNeuron[],
  stakeThresholdAlpha: number,
): ValidatorNeuron[] {
  return neurons.filter((n) => n.alphaStake >= stakeThresholdAlpha);
}

// The permit set the modelled rule implies: top-k by stake weight among eligible.
export function predictPermits(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThresholdAlpha: number,
  taoWeight: number,
): Set<number> {
  const predicted = new Set<number>();
  for (const w of rankedEligible(neurons, stakeThresholdAlpha, taoWeight).slice(
    0,
    maxValidators,
  )) {
    // A zero-weight UID clears the threshold only if the whole subnet is at zero
    // stake, in which case nobody is ranked above anybody — do not claim a permit.
    if (w.weight > 0) predicted.add(w.neuron.uid);
  }
  return predicted;
}

// How well the modelled rule reproduces the permits the chain actually granted.
//
// This is the drift guard, and it is the reason this module can be published from at
// all. `StakeThreshold` is sudo-settable and the rule is inference, so a caller that
// reports a floor without reporting this is asserting confidence it has not earned.
export function modelAgreement(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThresholdAlpha: number,
  taoWeight: number,
): ModelAgreement {
  const predicted = predictPermits(
    neurons,
    maxValidators,
    stakeThresholdAlpha,
    taoWeight,
  );
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

// True when more UIDs clear the floor than there are validator slots.
//
// Decides WHICH floor applies. Where the cap is not full — 127 of 128 subnets on
// 2026-08-03 — the floor is the threshold itself, and buying more alpha than that buys
// no additional claim on a permit.
export function capBinding(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThresholdAlpha: number,
): boolean {
  return eligible(neurons, stakeThresholdAlpha).length >= maxValidators;
}

// Alpha needed on this subnet to hold a validator permit.
//
// NOT "what incumbents happen to hold": where the cap is not binding the smallest
// permit-holder can sit far above the floor, and matching it overpays. Summing observed
// holdings across all 128 subnets gives ~15,000 TAO against a real requirement of ~1,300.
export function permitFloorAlpha(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThresholdAlpha: number,
  taoWeight: number,
): number {
  if (!capBinding(neurons, maxValidators, stakeThresholdAlpha))
    return stakeThresholdAlpha;
  const ranked = rankedEligible(neurons, stakeThresholdAlpha, taoWeight);
  const marginal = ranked[maxValidators - 1];
  return Math.max(stakeThresholdAlpha, marginal.neuron.alphaStake);
}

// Alpha held by the smallest permit-holder actually earning dividends.
//
// A permit is not earnings. Network-wide on 2026-08-03 the smallest earning validator
// held a median 7.4x the alpha of the smallest permit-holder (p90 20.7x); SN83 held 64
// permits against 7 earning validators. Empirical rather than a rule — it also depends
// on validating competently — so it is reported beside the floor, never instead of it.
// Null when nobody on the subnet earns.
export function earningFloorAlpha(
  neurons: readonly ValidatorNeuron[],
): number | null {
  let floor: number | null = null;
  for (const n of neurons) {
    if (!n.validatorPermit || n.dividends <= 0) continue;
    if (floor === null || n.alphaStake < floor) floor = n.alphaStake;
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

// Stake weight the given root stake would buy on this subnet, as a fraction.
//
// Root stake is counted in full on every subnet the hotkey is registered on — the
// single-pool leverage — but it buys a share of a pool already holding millions of TAO,
// so it saturates. Callers wanting the curve should sample several sizes rather than
// quoting one number.
export function marginalRootShare(
  neurons: readonly ValidatorNeuron[],
  addedRootTao: number,
  taoWeight: number,
): number {
  let totalRoot = addedRootTao;
  for (const n of neurons) totalRoot += n.rootStake;
  if (totalRoot <= 0) return 0;
  return (taoWeight * addedRootTao) / totalRoot;
}

/** Inputs a caller must supply; each is read live rather than assumed. */
export type EconomicsInputs = {
  neurons: readonly ValidatorNeuron[];
  maxValidators: number | null;
  /** SubtensorModule.StakeThreshold, read live. Sudo-settable — never a constant. */
  stakeThresholdAlpha: number | null;
  /** SubtensorModule.TaoWeight, read live. Sudo-settable — never a constant. */
  taoWeight: number | null;
  taoReserve: number | null;
  alphaReserve: number | null;
  /** Registration burn, added to both entry costs. */
  recycleCostTao: number;
};

// Compose the published shape, degrading rather than guessing.
//
// Every path that cannot produce a trustworthy number returns nulls plus a
// `degradedReason` naming the missing input. A confident `0` here would read as "free
// to validate", which is the specific wrong answer #9325 exists to prevent — and the
// same class of bug as #9285 / #9114, where an absent reader was served as fact.
export function buildValidatorEconomics(
  inputs: EconomicsInputs,
): ValidatorEconomics {
  const blank: ValidatorEconomics = {
    permitFloorAlpha: null,
    permitEntryCostTao: null,
    earningFloorAlpha: null,
    earningEntryCostTao: null,
    capBinding: null,
    composition: null,
    modelAgreement: null,
    degradedReason: null,
  };

  const { neurons, maxValidators, stakeThresholdAlpha, taoWeight } = inputs;
  if (stakeThresholdAlpha === null || taoWeight === null) {
    return { ...blank, degradedReason: "chain parameters unavailable" };
  }
  if (maxValidators === null || maxValidators <= 0) {
    return { ...blank, degradedReason: "max_validators unavailable" };
  }
  if (neurons.length === 0) {
    return { ...blank, degradedReason: "no metagraph rows for this subnet" };
  }

  const agreement = modelAgreement(
    neurons,
    maxValidators,
    stakeThresholdAlpha,
    taoWeight,
  );
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

  const floor = permitFloorAlpha(
    neurons,
    maxValidators,
    stakeThresholdAlpha,
    taoWeight,
  );
  const earnFloor = earningFloorAlpha(neurons);
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
    permitFloorAlpha: floor,
    permitEntryCostTao:
      floorCost === null ? null : floorCost + inputs.recycleCostTao,
    earningFloorAlpha: earnFloor,
    earningEntryCostTao:
      earnCost === null ? null : earnCost + inputs.recycleCostTao,
    capBinding: capBinding(neurons, maxValidators, stakeThresholdAlpha),
    composition,
    modelAgreement: agreement,
    // Reserves missing is a partial degrade: the alpha floors are still true, only
    // their TAO cost is unknown. Say so rather than implying the whole row is bad.
    degradedReason:
      floorCost === null ? "pool reserves unavailable — costs withheld" : null,
  };
}
