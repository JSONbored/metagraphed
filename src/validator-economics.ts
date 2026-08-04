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

  const agreement = modelAgreement(neurons, maxValidators, stakeThreshold);
  const composition = setComposition(neurons);
  // Composition and agreement are OBSERVED, not derived — they stay published even when
  // the model has drifted, because they are exactly what a caller needs to see why.
  if (!agreement.publishable) {
    return {
      ...blank,
      composition,
      // Takes are observed too, and stay published for the same reason composition does.
      takes: takeDistribution(neurons),
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
    capBinding: capBinding(neurons, maxValidators, stakeThreshold),
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
};

type HistoryRow = {
  snapshot_date: unknown;
  stake_tao: unknown;
  validator_permit: unknown;
  dividends: unknown;
  active: unknown;
};

type HistoryEmissionRow = {
  snapshot_date: unknown;
  tao_in_emission_tao: unknown;
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
): ValidatorEconomicsHistoryPoint[] {
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
    if (point.permitFloor === null || stake < point.permitFloor) {
      point.permitFloor = stake;
    }
    if (numeric(row.dividends) > 0) {
      point.earning += 1;
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
      return {
        snapshot_date,
        permit_floor_alpha: point.permitFloor,
        earning_floor_alpha: point.earningFloor,
        validators_permitted: point.permitted,
        validators_active: point.active,
        validators_earning: point.earning,
        emission_gate_open: inflow === null ? null : inflow > 0,
        tao_inflow_per_day: inflow === null ? null : inflow * BLOCKS_PER_DAY,
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
