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
  /**
   * Commission on delegated stake (#9327). Optional because the older callers of this
   * module do not read it; absent and null are the same thing here — a UID with no
   * recorded take is excluded from the distribution rather than counted as charging 0,
   * which would drag the median toward a floor nobody actually set.
   */
  take?: number | null;
  /**
   * SS58 of the hotkey at this UID. Optional for the same reason `take` is: only the
   * owner-exception path reads it, and a caller that cannot supply it gets the
   * pre-#9460 behaviour rather than a crash.
   */
  hotkey?: string | null;
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

/**
 * The commission picture across a subnet's permit-holders (#9327).
 *
 * Publishes the sorted vector, not just the summary, because the SHAPE is the
 * information and it is genuinely bimodal. Measured on SN64, 2026-08-03, permit-holders
 * charged `0, 0, 0.001, 0.01, 0.0135, 0.06, 0.09, 0.18 x9` — median 0.18, the ceiling
 * most sit at, against a visible cohort at or near zero competing for delegation.
 * Validators earn at both ends, so a lone median hides the entire structure.
 */
export type TakeDistribution = {
  median: number | null;
  min: number | null;
  max: number | null;
  /** Ascending, one entry per permit-holder that records a take. */
  distribution: number[];
  /**
   * Median restricted to permit-holders that actually earn. Takes among validators
   * nobody delegates to are noise — this is the competitive number.
   */
  medianEarning: number | null;
  sampleSize: number;
};

export type ValidatorEconomics = {
  permitFloorUnits: number | null;
  permitFloorCostTao: number | null;
  /** Floor cost plus the registration burn — what entry actually costs, not half of it. */
  permitEntryCostTao: number | null;
  earningFloorUnits: number | null;
  earningFloorCostTao: number | null;
  earningEntryCostTao: number | null;
  /**
   * How much more it takes to EARN than merely to hold a permit. Median 7.4x
   * network-wide, p90 20.7x — the single number that says a permit is not income.
   */
  permitToEarningMultiple: number | null;
  rootTaoToClear: number | null;
  capBinding: boolean | null;
  /** UIDs clearing the threshold — shows whether the cap is actually the constraint. */
  uidsAboveThreshold: number | null;
  validatorSlotsOpen: number | null;
  composition: SetComposition | null;
  takes: TakeDistribution | null;
  /** Per-subnet hyperparameter bounding what a childkey arrangement may charge (#9327). */
  minChildkeyTakeRatio: number | null;
  emissionGateOpen: boolean | null;
  taoInflowPerDay: number | null;
  registrationCostTao: number | null;
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

// The subnet owner's UID, when the owner hotkey is registered on its own subnet.
//
// Null when no owner hotkey was supplied (callers that predate #9460) or when the owner
// holds no UID here — an owner can run its subnet without registering a neuron on it.
export function ownerUid(
  neurons: readonly ValidatorNeuron[],
  ownerHotkey?: string | null,
): number | null {
  if (!ownerHotkey) return null;
  for (const n of neurons)
    if (n.hotkey && n.hotkey === ownerHotkey) return n.uid;
  return null;
}

// Validator slots left for everyone who is not the subnet owner.
//
// The owner's permit is unconditional but it is still ONE OF the `maxValidators` permits
// the subnet issues, so it comes out of the same budget. Where the cap does not bind
// this changes nothing; where it does, ignoring it would report a floor one rank too low.
function competitorSlots(maxValidators: number, owner: number | null): number {
  return Math.max(0, maxValidators - (owner === null ? 0 : 1));
}

// Eligible UIDs ranked by stake, with the owner removed — the field a non-owner
// actually competes against for the remaining slots.
function rankedCompetitors(
  neurons: readonly ValidatorNeuron[],
  stakeThreshold: number,
  owner: number | null,
): ValidatorNeuron[] {
  const all = ranked(neurons, stakeThreshold);
  return owner === null ? all : all.filter((n) => n.uid !== owner);
}

// The permit set the rule implies: the subnet owner unconditionally, then top-k by total
// stake among the remaining UIDs clearing the threshold.
//
// ## Why the owner is unconditional
//
// Measured 2026-08-05 across the 13 subnets whose agreement had fallen below the
// publishable floor: 9 of 9 remaining residuals were the subnet owner holding a permit
// the stake rule cannot explain — three of them at EXACTLY zero stake — and
// over-prediction was 0 on every subnet. Modelling the owner takes all 13 to 1.0.
//
// The other 5 residuals present that day were transient: UIDs that had dropped below the
// threshold but whose permit had not yet been recomputed. Permits recompute once per
// tempo while stake moves continuously, so a snapshot always contains some. They cleared
// on their own within the hour and are deliberately NOT modelled here — they are timing,
// not a rule, and `modelAgreement` is what reports them.
export function predictPermits(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
  ownerHotkey?: string | null,
): Set<number> {
  const owner = ownerUid(neurons, ownerHotkey);
  const predicted = new Set<number>();
  if (owner !== null) predicted.add(owner);
  for (const n of rankedCompetitors(neurons, stakeThreshold, owner).slice(
    0,
    competitorSlots(maxValidators, owner),
  )) {
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
  ownerHotkey?: string | null,
): ModelAgreement {
  const predicted = predictPermits(
    neurons,
    maxValidators,
    stakeThreshold,
    ownerHotkey,
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

// True when more UIDs clear the threshold than there are validator slots.
//
// Decides WHICH floor applies. Where the cap is not full — 127 of 128 subnets on
// 2026-08-03 — the floor is the threshold itself, and extra stake buys no additional
// claim on a permit (though it still buys dividend share).
export function capBinding(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
  ownerHotkey?: string | null,
): boolean {
  const owner = ownerUid(neurons, ownerHotkey);
  return (
    rankedCompetitors(neurons, stakeThreshold, owner).length >=
    competitorSlots(maxValidators, owner)
  );
}

// Total-stake units needed to hold a permit on this subnet.
export function permitFloorUnits(
  neurons: readonly ValidatorNeuron[],
  maxValidators: number,
  stakeThreshold: number,
  ownerHotkey?: string | null,
): number {
  if (!capBinding(neurons, maxValidators, stakeThreshold, ownerHotkey))
    return stakeThreshold;
  // The owner's unconditional permit is not a rank a non-owner can take, so the marginal
  // seat is the last COMPETITOR slot — one lower than the raw cap when an owner holds one.
  const owner = ownerUid(neurons, ownerHotkey);
  const competitors = rankedCompetitors(neurons, stakeThreshold, owner);
  const marginal = competitors[competitorSlots(maxValidators, owner) - 1];
  return marginal === undefined
    ? stakeThreshold
    : Math.max(stakeThreshold, marginal.totalStake);
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

/**
 * Median of an already-ascending vector. Even lengths average the middle pair, which is
 * the convention the take figures elsewhere in this repo use.
 */
function medianOfSorted(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Take distribution across permit-holders (#9327).
 *
 * Only permit-holders count: a take set by a UID with no permit is not part of the
 * competitive field. A UID whose take is absent or non-finite is skipped rather than
 * read as 0 — see the note on `ValidatorNeuron.take`.
 */
export function takeDistribution(
  neurons: readonly ValidatorNeuron[],
): TakeDistribution {
  const takesOf = (rows: readonly ValidatorNeuron[]) =>
    rows
      .map((n) => n.take)
      .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
      .sort((a, b) => a - b);

  const permitted = neurons.filter((n) => n.validatorPermit);
  const all = takesOf(permitted);
  const earning = takesOf(permitted.filter((n) => n.dividends > 0));

  return {
    median: medianOfSorted(all),
    min: all.length > 0 ? all[0] : null,
    max: all.length > 0 ? all[all.length - 1] : null,
    distribution: all,
    medianEarning: medianOfSorted(earning),
    sampleSize: all.length,
  };
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
  /**
   * Per-block TAO injected into this subnet's pool. 0 means the emission gate is closed.
   * Reported, never scored: gate-closed subnets still emit alpha at a comparable rate
   * and are less contested, so per unit of stake they pay MORE. The gate is an
   * exit-liquidity question, not an eligibility one.
   */
  taoInEmissionPerBlock?: number | null;
  /** Live recycle/burn cost. Entry is two spends and publishing one understates it. */
  registrationCostTao?: number | null;
  minChildkeyTakeRatio?: number | null;
  /**
   * The subnet owner's hotkey (#9460). The owner holds a validator permit unconditionally,
   * so the permit model cannot reproduce the chain without it — absent, every subnet whose
   * owner sits below the stake threshold reports a permanent model disagreement and stops
   * publishing its floors.
   */
  ownerHotkey?: string | null;
};

// 12s blocks.
const BLOCKS_PER_DAY = 7200;

// Compose the published shape, degrading rather than guessing.
//
// Every path that cannot produce a trustworthy number returns nulls plus a
// `degradedReason` naming the missing input. A confident `0` here would read as "free to
// validate" — the same class of bug as #9285 / #9114, where an absent reader was served
// as fact.
export function buildValidatorEconomics(
  inputs: EconomicsInputs,
): ValidatorEconomics {
  const inflow =
    typeof inputs.taoInEmissionPerBlock === "number" &&
    Number.isFinite(inputs.taoInEmissionPerBlock)
      ? inputs.taoInEmissionPerBlock
      : null;
  const burn =
    typeof inputs.registrationCostTao === "number" &&
    Number.isFinite(inputs.registrationCostTao)
      ? inputs.registrationCostTao
      : null;

  const blank: ValidatorEconomics = {
    permitFloorUnits: null,
    permitFloorCostTao: null,
    permitEntryCostTao: null,
    earningFloorUnits: null,
    earningFloorCostTao: null,
    earningEntryCostTao: null,
    permitToEarningMultiple: null,
    rootTaoToClear: null,
    capBinding: null,
    uidsAboveThreshold: null,
    validatorSlotsOpen: null,
    composition: null,
    takes: null,
    minChildkeyTakeRatio: inputs.minChildkeyTakeRatio ?? null,
    // Gate state and burn are READ, not derived — they stay published on every
    // degraded path, because they are the two fields that need no model to be true.
    emissionGateOpen: inflow === null ? null : inflow > 0,
    taoInflowPerDay: inflow === null ? null : inflow * BLOCKS_PER_DAY,
    registrationCostTao: burn,
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

  const ownerHotkey = inputs.ownerHotkey ?? null;
  const agreement = modelAgreement(
    neurons,
    maxValidators,
    stakeThreshold,
    ownerHotkey,
  );
  const composition = setComposition(neurons);
  // Composition and agreement are OBSERVED, not derived — they stay published even when
  // the model has drifted, because they are exactly what a caller needs to see why.
  if (!agreement.publishable) {
    return {
      ...blank,
      composition,
      // Takes are observed too, and stay published for the same reason composition does.
      takes: takeDistribution(neurons),
      // So are these four (#9460). Suppressing the FLOOR when the permit model has
      // drifted is right — a wrong floor reads as a price. But none of these depends on
      // the floor model:
      //   cap_binding / uids_above_threshold  count UIDs against the live threshold
      //   validator_slots_open                is max_validators minus observed permits
      //   root_tao_to_clear_threshold         is threshold / tao_weight, pure arithmetic
      // Nulling them forced every consumer to guess, and the guess is asymmetric: assume
      // an open cap on a subnet that is actually full and the floor you compute is too low.
      capBinding: capBinding(
        neurons,
        maxValidators,
        stakeThreshold,
        ownerHotkey,
      ),
      uidsAboveThreshold: eligible(neurons, stakeThreshold).length,
      validatorSlotsOpen: Math.max(0, maxValidators - composition.permitted),
      rootTaoToClear: rootTaoToClear(stakeThreshold, taoWeight),
      modelAgreement: agreement,
      degradedReason:
        "permit model disagrees with observed permits on this subnet",
    };
  }

  const floor = permitFloorUnits(
    neurons,
    maxValidators,
    stakeThreshold,
    ownerHotkey,
  );
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

  const withBurn = (cost: number | null) =>
    cost === null || burn === null ? null : cost + burn;

  return {
    ...blank,
    permitFloorUnits: floor,
    permitFloorCostTao: floorCost,
    permitEntryCostTao: withBurn(floorCost),
    earningFloorUnits: earnFloor,
    earningFloorCostTao: earnCost,
    earningEntryCostTao: withBurn(earnCost),
    permitToEarningMultiple:
      earnFloor === null || floor <= 0 ? null : earnFloor / floor,
    rootTaoToClear: rootTaoToClear(stakeThreshold, taoWeight),
    capBinding: capBinding(neurons, maxValidators, stakeThreshold, ownerHotkey),
    uidsAboveThreshold: eligible(neurons, stakeThreshold).length,
    validatorSlotsOpen: Math.max(0, maxValidators - composition.permitted),
    composition,
    takes: takeDistribution(neurons),
    modelAgreement: agreement,
    // Reserves missing is a partial degrade: the unit floors are still true, only their
    // TAO cost is unknown. Say so rather than implying the whole row is bad.
    degradedReason:
      floorCost === null ? "pool reserves unavailable — costs withheld" : null,
  };
}

// ---------------------------------------------------------------------------
// Cross-subnet ranking (#9324): "across all of them, where is it cheapest to
// become an EARNING validator". The per-subnet answer cannot be assembled into
// this by a caller without reimplementing the ranking, and the inputs it depends
// on — execution price against live reserves, the live StakeThreshold, the
// emission gate — move independently, so a client that cached any of them would
// rank wrongly with no way to know.
// ---------------------------------------------------------------------------

/**
 * One subnet's row in the ranking: its economics, the netuid that owns them, and the
 * cap they were derived against.
 *
 * `maxValidators` is carried rather than looked up again at serialisation time — a
 * second lookup would re-derive a value the derivation already consumed, and its
 * null arm is unreachable anyway (a subnet with no cap degrades and never survives
 * the ranking), so it reads as a live branch that can never be exercised.
 */
export type ValidatorEconomicsRow = ValidatorEconomics & {
  netuid: number;
  maxValidators: number | null;
};

/**
 * The sortable keys, as a closed set.
 *
 * Deliberately does NOT include the burn-inclusive entry costs. The current
 * registration burn is a live per-subnet chain read (`SubtensorModule.Burn`) with
 * no cached tier, so ranking on it would mean ~128 live reads per request. It is
 * also immaterial to the ORDER — measured 2026-08-03, the burn runs ~0.15 TAO
 * against floor costs of tens to hundreds — so excluding it changes the ranking
 * essentially never, while pretending to include it would be either slow or stale.
 * The per-subnet route reads it live and reports the true entry cost.
 */
export const VALIDATOR_ECONOMICS_SORTS = [
  "earning_floor_cost_tao",
  "permit_floor_cost_tao",
  "permit_to_earning_multiple",
  "tao_inflow_per_day",
  "validator_headroom",
] as const;
export type ValidatorEconomicsSort = (typeof VALIDATOR_ECONOMICS_SORTS)[number];

/**
 * Thrown when a caller names a sort key that does not exist (#9460).
 *
 * A distinct type rather than a bare Error so each surface can map it to its own
 * shape — REST to a 400, MCP to `invalid_params` — without string-matching a message.
 */
export class UnsupportedSortError extends Error {
  // Plain fields, not constructor parameter properties: these modules are loaded by
  // Node's strip-only TypeScript mode, which rejects that syntax outright.
  readonly supported: readonly string[] = VALIDATOR_ECONOMICS_SORTS;
  readonly requested: string;
  constructor(requested: string) {
    super(
      `${requested} is not a supported sort. Supported: ${VALIDATOR_ECONOMICS_SORTS.join(", ")}.`,
    );
    this.name = "UnsupportedSortError";
    this.requested = requested;
  }
}

/** Ascending for costs (cheapest first), descending for the "more is better" keys. */
const DESCENDING_SORTS = new Set<string>([
  "tao_inflow_per_day",
  "validator_headroom",
]);

function sortValue(row: ValidatorEconomicsRow, sort: string): number | null {
  if (sort === "validator_headroom") return row.validatorSlotsOpen;
  if (sort === "permit_to_earning_multiple") return row.permitToEarningMultiple;
  if (sort === "tao_inflow_per_day") return row.taoInflowPerDay;
  if (sort === "permit_floor_cost_tao") return row.permitFloorCostTao;
  return row.earningFloorCostTao;
}

export type ValidatorEconomicsRankingOptions = {
  sort?: ValidatorEconomicsSort | string;
  /** When set, keep only subnets whose gate matches. Unset means "both". */
  emissionGateOpen?: boolean | null;
  capBinding?: boolean | null;
  limit?: number;
  offset?: number;
};

export type ValidatorEconomicsRanking = {
  rows: ValidatorEconomicsRow[];
  total: number;
  /** Subnets dropped by a filter or by having no sortable value, with the reason. */
  excluded: Array<{ netuid: number; reason: string }>;
  sort: string;
  order: "asc" | "desc";
};

/**
 * Rank subnets by cost-to-earn, reporting what it excluded and why.
 *
 * A subnet with no value for the chosen sort is EXCLUDED with a reason rather than
 * sorted as 0 or as infinity: an unpriceable pool is not the cheapest subnet on the
 * network, and a degraded row is not a free one. "Why is SN45 not in this list" is
 * the question the output gets asked next, and a ranking that cannot answer it gets
 * overridden by hand.
 */
export function rankValidatorEconomics(
  rows: readonly ValidatorEconomicsRow[],
  options: ValidatorEconomicsRankingOptions = {},
): ValidatorEconomicsRanking {
  // An ABSENT sort takes the default; an unsupported one is rejected (#9460).
  //
  // These are different questions and this silently answered both with the default:
  // asking to rank by `tao_inflow_per_day` and mistyping it returned a list ranked by
  // cost, echoing `sort: "earning_floor_cost_tao"` back, with no error. The caller gets
  // a plausible ranking that answers a question it did not ask — and on MCP, where the
  // input schema is not enforced at dispatch, a model's guess landed here directly.
  // REST already rejected the same input with a 400; the two surfaces now agree.
  if (
    options.sort != null &&
    options.sort !== "" &&
    !VALIDATOR_ECONOMICS_SORTS.includes(options.sort as ValidatorEconomicsSort)
  ) {
    throw new UnsupportedSortError(String(options.sort));
  }
  const sort = VALIDATOR_ECONOMICS_SORTS.includes(
    options.sort as ValidatorEconomicsSort,
  )
    ? (options.sort as ValidatorEconomicsSort)
    : VALIDATOR_ECONOMICS_SORTS[0];
  const order: "asc" | "desc" = DESCENDING_SORTS.has(sort) ? "desc" : "asc";

  const excluded: Array<{ netuid: number; reason: string }> = [];
  const kept: ValidatorEconomicsRow[] = [];

  for (const row of rows) {
    if (
      options.emissionGateOpen != null &&
      row.emissionGateOpen !== options.emissionGateOpen
    ) {
      excluded.push({
        netuid: row.netuid,
        reason: `emission_gate_open is ${row.emissionGateOpen}`,
      });
      continue;
    }
    if (options.capBinding != null && row.capBinding !== options.capBinding) {
      excluded.push({
        netuid: row.netuid,
        reason: `cap_binding is ${row.capBinding}`,
      });
      continue;
    }
    if (sortValue(row, sort) === null) {
      excluded.push({ netuid: row.netuid, reason: `${sort} is unavailable` });
      continue;
    }
    kept.push(row);
  }

  // Ties broken by netuid so two runs against identical chain state produce an
  // identical page — an unstable order makes a diff between runs unreadable and
  // makes offset pagination silently drop or repeat rows.
  kept.sort((a, b) => {
    const av = sortValue(a, sort) as number;
    const bv = sortValue(b, sort) as number;
    if (av !== bv) return order === "asc" ? av - bv : bv - av;
    return a.netuid - b.netuid;
  });

  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? kept.length;
  return {
    rows: kept.slice(offset, offset + limit),
    total: kept.length,
    excluded,
    sort,
    order,
  };
}

/**
 * Group a flat cross-subnet neuron scan into per-netuid buckets.
 *
 * One scan and one grouping rather than 128 per-subnet reads — the same shape
 * `chain-yield` uses over this table.
 */
export function groupNeuronsByNetuid(
  rows: ReadonlyArray<{ netuid: number } & ValidatorNeuron>,
): Map<number, ValidatorNeuron[]> {
  const out = new Map<number, ValidatorNeuron[]>();
  for (const row of rows) {
    const bucket = out.get(row.netuid);
    const neuron: ValidatorNeuron = {
      uid: row.uid,
      // Rebuilt field-by-field rather than spread, so every field this module reads has
      // to be named here — `hotkey` included, or the owner exception (#9460) silently
      // sees an unowned subnet on the cross-subnet ranking route only.
      hotkey: row.hotkey ?? null,
      totalStake: row.totalStake,
      validatorPermit: row.validatorPermit,
      dividends: row.dividends,
      active: row.active,
      take: row.take,
    };
    if (bucket) bucket.push(neuron);
    else out.set(row.netuid, [neuron]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// History (#9326). A floor is a point-in-time number; the decision it informs is
// a trend one. A subnet whose permit floor has doubled in a month is filling up,
// and entering it now buys a contested position; one whose earning floor is
// falling is emptying out. Same snapshot value, opposite decisions.
// ---------------------------------------------------------------------------

/**
 * One day's observed economics for a subnet.
 *
 * The floors here are OBSERVED, not re-derived: `permitFloorAlpha` is the
 * smallest stake that actually held a permit that day, read off the snapshot.
 *
 * That is deliberate and it matters. `StakeThreshold` is sudo-settable, so
 * re-running TODAY's threshold against a historical snapshot would report what
 * the floor would have been under today's rules, not what it was — and a series
 * built that way would show a flat floor across a governance change that actually
 * moved it. History is a record of what happened, not a re-run of the model.
 */
export type ValidatorEconomicsHistoryPoint = {
  snapshot_date: string;
  permit_floor_alpha: number | null;
  earning_floor_alpha: number | null;
  validators_permitted: number;
  validators_active: number;
  validators_earning: number;
  emission_gate_open: boolean | null;
  tao_inflow_per_day: number | null;
  /**
   * The subnet's validator cap (#9460). Carried on every point because
   * `permit_floor_alpha` is the observed floor REGARDLESS of cap state, so it cannot be
   * read without knowing whether the cap was the binding constraint that day — and
   * joining today's cap onto a historical point is silently wrong for any subnet whose
   * cap moved inside the window, which is exactly the join a consumer was forced into.
   *
   * Resolved per day from the hyperparameter change-log where that reaches back far
   * enough, and from the live cap otherwise — `max_validators_source` says which, so the
   * approximation is never silent. Null when unknown, never 0: an unknown cap must not
   * read as "no slots".
   */
  max_validators: number | null;
  /**
   * Where this point's `max_validators` came from.
   *
   * `observed` — the change-log recorded this cap at or before this day, so it is what
   *   the subnet actually had.
   * `current`  — the change-log does not reach this far back, so the LIVE cap is
   *   reported. Correct unless the cap moved, which is precisely the case a consumer
   *   has to be able to detect. The change-log began filling 2026-08-04, so older
   *   points read `current` and become `observed` as it accumulates.
   *
   * Null exactly when `max_validators` is null.
   */
  max_validators_source: "observed" | "current" | null;
  /**
   * Whether the permit set was FULL on this day: `validators_permitted >= max_validators`.
   *
   * Deliberately NOT named `cap_binding`. The per-subnet record's `cap_binding` is a
   * forward-looking measure over UIDs that CLEAR THE THRESHOLD (candidates against
   * slots); only the permitted set survives in the daily snapshot, so the same name
   * would ship a different quantity — the silent-mismatch class this module exists to
   * avoid. Null when the cap is unknown.
   */
  permit_set_full: boolean | null;
};

type HistoryRow = {
  snapshot_date: unknown;
  stake_tao: unknown;
  validator_permit: unknown;
  dividends: unknown;
  active: unknown;
  hotkey?: unknown;
};

type HistoryEmissionRow = {
  snapshot_date: unknown;
  tao_in_emission_tao: unknown;
};

/** One `subnet_hyperparams_history` entry: a CHANGE, not a daily value. */
type HistoryCapRow = {
  observed_at: unknown;
  max_validators: unknown;
};

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fold per-UID daily rows into one point per snapshot date.
 *
 * Cost fields are deliberately absent from the series. A historical TAO cost needs
 * the pool reserves AS THEY WERE, priced at the time; reconstructing one from
 * today's reserves would be wrong in exactly the way the moving-price trap already
 * catches elsewhere. Alpha floors are unambiguous; cost is a present-tense question,
 * and the per-subnet route answers it.
 */
export function buildValidatorEconomicsHistory(
  rows: readonly HistoryRow[],
  emissionRows: readonly HistoryEmissionRow[] = [],
  options: {
    /** The LIVE cap, used only for days the change-log does not reach. */
    maxValidators?: number | null;
    /**
     * `subnet_hyperparams_history` rows for this subnet: a change-log, so the cap in
     * force on a given day is the newest entry at or before it, not an entry per day.
     */
    capHistory?: readonly HistoryCapRow[];
    /**
     * The subnet owner's hotkey (#9460). The owner's permit is unconditional, so its
     * stake is not a floor anyone else can enter at — a subnet whose owner holds a
     * permit at ~0 published `permit_floor_alpha: 0`, which reads as "free to validate",
     * the same wrong answer the per-subnet route already fails closed on.
     */
    ownerHotkey?: string | null;
  } = {},
): ValidatorEconomicsHistoryPoint[] {
  const positiveCap = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const liveCap = positiveCap(options.maxValidators);
  const ownerHotkey = options.ownerHotkey || null;

  // Ascending by observation time so the newest entry at or before a day is a scan
  // backwards from the end — a change-log, not a per-day series.
  const capLog = [...(options.capHistory ?? [])]
    .map((row) => ({
      observedAt: Number(row.observed_at),
      cap: positiveCap(row.max_validators),
    }))
    .filter((row) => Number.isFinite(row.observedAt) && row.cap !== null)
    .sort((a, b) => a.observedAt - b.observedAt);

  // The cap in force at the END of a day — the snapshot is taken across it, and a
  // change landing that morning is the cap that day's permits were computed against.
  const capForDate = (
    date: string,
  ): { cap: number | null; source: "observed" | "current" | null } => {
    const endOfDay = Date.parse(`${date}T23:59:59.999Z`);
    if (Number.isFinite(endOfDay)) {
      for (let i = capLog.length - 1; i >= 0; i -= 1) {
        if (capLog[i].observedAt <= endOfDay) {
          return { cap: capLog[i].cap, source: "observed" };
        }
      }
    }
    return { cap: liveCap, source: liveCap === null ? null : "current" };
  };
  const emissionByDate = new Map<string, number | null>();
  for (const row of emissionRows) {
    const date = String(row.snapshot_date);
    const raw = row.tao_in_emission_tao;
    emissionByDate.set(
      date,
      raw === null || raw === undefined || !Number.isFinite(Number(raw))
        ? null
        : Number(raw),
    );
  }

  const byDate = new Map<
    string,
    {
      permitFloor: number | null;
      earningFloor: number | null;
      permitted: number;
      active: number;
      earning: number;
    }
  >();

  for (const row of rows) {
    const date = String(row.snapshot_date);
    let point = byDate.get(date);
    if (!point) {
      point = {
        permitFloor: null,
        earningFloor: null,
        permitted: 0,
        active: 0,
        earning: 0,
      };
      byDate.set(date, point);
    }
    // Only permit-holders shape a floor: a UID with no permit says nothing about
    // what holding one required.
    if (numeric(row.validator_permit) !== 1) continue;
    const stake = numeric(row.stake_tao);
    point.permitted += 1;
    if (numeric(row.active) === 1) point.active += 1;
    // The owner still COUNTS as permitted — that is observed truth — but its stake is
    // not a price anyone else can pay, so it never sets a floor (#9460).
    const isOwner =
      ownerHotkey !== null &&
      row.hotkey != null &&
      String(row.hotkey) === ownerHotkey;
    if (numeric(row.dividends) > 0) point.earning += 1;
    if (isOwner) continue;
    if (point.permitFloor === null || stake < point.permitFloor) {
      point.permitFloor = stake;
    }
    if (numeric(row.dividends) > 0) {
      if (point.earningFloor === null || stake < point.earningFloor) {
        point.earningFloor = stake;
      }
    }
  }

  // A date present only in the emission series still deserves a point: a gate
  // close on a day the neuron snapshot missed is exactly the transition this
  // series exists to make visible.
  for (const date of emissionByDate.keys()) {
    if (!byDate.has(date)) {
      byDate.set(date, {
        permitFloor: null,
        earningFloor: null,
        permitted: 0,
        active: 0,
        earning: 0,
      });
    }
  }

  return [...byDate.entries()]
    .map(([snapshot_date, point]) => {
      const inflow = emissionByDate.has(snapshot_date)
        ? (emissionByDate.get(snapshot_date) ?? null)
        : null;
      const { cap, source: capSource } = capForDate(snapshot_date);
      return {
        snapshot_date,
        permit_floor_alpha: point.permitFloor,
        earning_floor_alpha: point.earningFloor,
        validators_permitted: point.permitted,
        validators_active: point.active,
        validators_earning: point.earning,
        emission_gate_open: inflow === null ? null : inflow > 0,
        tao_inflow_per_day: inflow === null ? null : inflow * BLOCKS_PER_DAY,
        max_validators: cap,
        max_validators_source: capSource,
        permit_set_full: cap === null ? null : point.permitted >= cap,
      };
    })
    .sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
}

/** Windows the history route accepts, matching its sibling history routes. */
export const VALIDATOR_ECONOMICS_HISTORY_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_VALIDATOR_ECONOMICS_HISTORY_WINDOW = "30d";

/**
 * Safety valve on the raw per-UID daily read.
 *
 * ~256 UIDs x 90d is ~23k rows; this leaves head room so a full window is never
 * silently truncated mid-day, which would report a partial day as a real drop in
 * the permitted count — a trend artefact indistinguishable from a real one.
 */
export const VALIDATOR_ECONOMICS_HISTORY_ROW_CAP = 40_000;
