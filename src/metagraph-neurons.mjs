// Shape `neurons` rows (migration 0007; also the Postgres mirror written by
// workers/data-api.mjs's handleNeuronsSync, #4771) into the per-UID metagraph
// API responses for #1304/#1305 (epic #1302). Populated by the refresh-metagraph
// cron first-party via the Bittensor SDK (#1348) -- no Taostats, no API key.
// Pure + exported for tests; the Worker handlers run the D1 or Postgres query
// and call these builders.

import { buildAccountIdentity, IDENTITY_FIELDS } from "./account-identity.ts";

// The columns the handlers SELECT for a neuron row.
export const NEURON_COLUMNS =
  "uid, hotkey, coldkey, active, validator_permit, rank, trust, validator_trust, " +
  "consensus, incentive, dividends, emission_tao, stake_tao, registered_at_block, " +
  "is_immunity_period, axon, block_number, captured_at, take";

// The full column set written to the neurons table (matches migration 0007 and
// the normalizeNeuron row shape). Used by the cron's parameterized bulk load
// (loadStagedNeurons) — values are always bound, never interpolated into SQL.
export const NEURON_INSERT_COLUMNS = [
  "netuid",
  "uid",
  "hotkey",
  "coldkey",
  "active",
  "validator_permit",
  "rank",
  "trust",
  "validator_trust",
  "consensus",
  "incentive",
  "dividends",
  "emission_tao",
  "stake_tao",
  "registered_at_block",
  "is_immunity_period",
  "axon",
  "block_number",
  "captured_at",
  "take",
];

export const GLOBAL_VALIDATOR_SORTS = [
  "avg_validator_trust",
  "max_validator_trust",
  "stake_dominance",
  "subnet_count",
  "total_emission",
  "total_stake",
  "uid_count",
];
export const DEFAULT_GLOBAL_VALIDATOR_SORT = "subnet_count";
export const GLOBAL_VALIDATOR_LIMIT_DEFAULT = 20;
export const GLOBAL_VALIDATOR_LIMIT_MAX = 100;
const GLOBAL_VALIDATOR_SUBNET_LIMIT = 10;
const RAO_PER_TAO = 1e9;

// Bittensor's network-wide block time is a long-stable EXTERNAL protocol
// parameter (~12s) that this repo does not measure per-request -- distinct
// from any live-computed block-time distribution elsewhere in this repo
// (e.g. blocks-summary.mjs's blockTimeDistribution), which would make the
// same emission_tao annualize differently on every request purely from
// block-production jitter. If a future chain upgrade changes Bittensor's
// consensus block time, this constant needs a matching update; it is a
// documented assumption apy_estimate depends on, not something this route
// verifies (#2551).
const APY_SECONDS_PER_BLOCK = 12;
// Calendar year, no leap-day adjustment -- a documented convention, not a
// protocol-derived figure. No prior art for "a year" exists elsewhere in
// this repo (src/chain-yield.ts / src/subnet-yield.mjs are explicitly
// snapshot-only, never annualized) -- apy_estimate is the new precedent.
const APY_SECONDS_PER_YEAR = 365 * 24 * 60 * 60; // 31,536,000

function toIso(ms) {
  // D1 can return the INTEGER captured_at as a numeric string; a bare
  // Number.isFinite(ms) is false for a string, so the old form dropped a real
  // snapshot timestamp to null. Coerce first and require n > 0 so null/blank/
  // invalid cells stay null (never epoch 1970). Mirrors the blocks/extrinsics
  // toIso fixes (#2708/#2714) and the captured_at coercion in #2725.
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value) {
  // Guard null first: Number(null) === 0, so a null column (block_number is a
  // nullable INTEGER) would masquerade as the real chain height / netuid / uid 0
  // instead of "absent". A numeric string like "10" from D1 must still pass.
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function roundTao(value) {
  return Math.round(numberOrZero(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Sum in rao-integer BigInt space, not float space -- summing every validator
// UID's stake_tao/emission_tao per hotkey (network-wide, unbounded) with plain
// `+=` compounds rounding error across the accumulation even when each
// individual value is itself exact (metagraphed#2922, mirrors the toRaoBig
// pattern in src/chain-yield.ts and the toRao helper proven in
// src/account-balance.mjs for #2070). Convert back to TAO only once, at the
// very end. Callers always pass an already-finite numberOrZero()/roundTao()
// result, so no isFinite guard here.
function toRaoBig(tao) {
  return BigInt(Math.round(tao * RAO_PER_TAO));
}
function raoBigToTao(rao) {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function round(value, dp = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// 1 TAO = 1e9 rao; round yield-shaped outputs to that precision to shed
// IEEE-754 noise below the rao floor while keeping small ratios meaningful.
// Matches src/chain-yield.ts / src/subnet-yield.mjs's own round9 exactly
// (apy_estimate is a sibling yield-shaped field, not a trust/take value, so
// it uses this precision convention rather than round()'s 6dp default).
function round9(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(Number(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 0/1 INTEGER flag cell to a boolean. Numeric strings like "0"
// must not pass through Boolean(), which treats any non-empty string as true.
// Mirrors the local toD1Flag added to formatRegistration by #2487.
function toD1Flag(value) {
  return Number(value) === 1;
}

// coerce the flag columns back to real booleans for the API (toD1Flag
// handles the D1 INTEGER 0/1 cells; nonNegativeInt/nullableNumber coerce
// string-typed uid/registered_at_block into real integers, and roundTao
// rounds stake_tao / emission_tao to rao precision). The explicit null
// guards preserve the previous null-on-missing contract: Number(null) is
// 0 (not NaN), so nonNegativeInt(null) / nullableNumber(null) / roundTao(null)
// would otherwise serialize as 0 instead of null. roundTao itself falls
// back to numberOrZero(0) for null/non-finite, so the wrapping guards here
// are what keep "missing cell" cells flowing through as null. Mirrors the
// proven toBlockNumber / toTaoOrNull null-guards in account-events.mjs
// (#2487).
// featuredHotkeys (optional) is a Set of hotkeys from the featured_validators
// side table (#5166; see deploy/postgres/schema.sql for why that's a separate
// hotkey-keyed table rather than a `neurons` column). Only passed by the
// validator-list builders below -- buildSubnetMetagraph/buildNeuronDetail/
// buildValidatorDetail never pass one, so `featured` is simply omitted from
// their Neuron output, leaving those artifacts' shape unchanged.
// #6640 (TaoSwap finding, #5968 survey): a neuron still inside its immunity
// window can't be pruned for low incentive yet -- a deregistration-risk
// signal. immunity_period is a governance-adjustable per-subnet hyperparameter
// (never hardcoded -- mirrors the MaxDelegateTake/TxDelegateTakeRateLimit
// convention, #5229; see also docs/conviction-lock-mechanism.md's UnlockRate
// caveat), so the caller live-reads it (subnet_hyperparams) and passes it in
// -- this does no I/O of its own. Anchors the wall-clock ETA off the row's OWN
// block_number/captured_at, not "now": every response is itself a
// point-in-time snapshot, so the estimate is reproducible from that snapshot
// alone rather than drifting with whenever the API happens to be called.
// Reuses APY_SECONDS_PER_BLOCK, the same ~12s/block assumption apy_estimate
// already depends on. Exported for direct unit testing, mirroring
// src/concentration.ts's pure-statistics convention; formatNeuron is its only
// real caller.
export function computeImmunityWindow(row, neuron, immunityPeriod) {
  if (!neuron.is_immunity_period || neuron.registered_at_block == null) {
    return {};
  }
  const expiresAtBlock = neuron.registered_at_block + immunityPeriod;
  const snapshotBlock = nonNegativeInt(row.block_number);
  const capturedAtMs = row.captured_at == null ? null : Number(row.captured_at);
  let expiresAt = null;
  if (
    snapshotBlock != null &&
    Number.isFinite(capturedAtMs) &&
    capturedAtMs > 0
  ) {
    const blocksRemaining = expiresAtBlock - snapshotBlock;
    if (blocksRemaining > 0) {
      expiresAt = toIso(
        capturedAtMs + blocksRemaining * APY_SECONDS_PER_BLOCK * 1000,
      );
    }
  }
  return {
    immunity_expires_at_block: expiresAtBlock,
    immunity_expires_at: expiresAt,
  };
}

// immunityPeriod (optional) is the subnet's live immunity_period hyperparameter
// (#6640) -- only buildSubnetMetagraph/buildNeuronDetail pass one; every other
// caller (buildSubnetValidators/buildGlobalValidators/buildValidatorDetail)
// omits it, so their rows get no immunity_expires_at* keys at all (not
// null-valued ones), keeping their own additionalProperties:false schemas
// untouched by this change.
export function formatNeuron(row, featuredHotkeys, immunityPeriod) {
  if (!row || typeof row !== "object") return null;
  const hotkey = row.hotkey ?? null;
  const neuron = {
    uid: row.uid == null ? null : nonNegativeInt(row.uid),
    hotkey,
    coldkey: row.coldkey ?? null,
    active: toD1Flag(row.active),
    validator_permit: toD1Flag(row.validator_permit),
    rank: row.rank == null ? null : round(nullableNumber(row.rank)),
    trust: row.trust == null ? null : round(nullableNumber(row.trust)),
    validator_trust:
      row.validator_trust == null
        ? null
        : round(nullableNumber(row.validator_trust)),
    consensus:
      row.consensus == null ? null : round(nullableNumber(row.consensus)),
    incentive:
      row.incentive == null ? null : round(nullableNumber(row.incentive)),
    dividends:
      row.dividends == null ? null : round(nullableNumber(row.dividends)),
    emission_tao: row.emission_tao == null ? null : roundTao(row.emission_tao),
    stake_tao: row.stake_tao == null ? null : roundTao(row.stake_tao),
    registered_at_block:
      row.registered_at_block == null
        ? null
        : nonNegativeInt(row.registered_at_block),
    is_immunity_period: toD1Flag(row.is_immunity_period),
    axon: row.axon ?? null,
    // Global per-hotkey (SubtensorModule::Delegates), not per (netuid, uid) --
    // null means no Delegates entry at capture time (#2548).
    take: row.take == null ? null : round(nullableNumber(row.take)),
  };
  if (featuredHotkeys) {
    neuron.featured = Boolean(hotkey && featuredHotkeys.has(hotkey));
  }
  if (Number.isSafeInteger(immunityPeriod) && immunityPeriod >= 0) {
    Object.assign(neuron, computeImmunityWindow(row, neuron, immunityPeriod));
  }
  return neuron;
}

// All rows of one subnet's snapshot share the same captured_at/block_number.
function snapshotStamp(rows) {
  const first = rows[0] || {};
  return {
    captured_at: toIso(first.captured_at),
    // Coerce like buildGlobalValidators (#2611): block_number is a nullable D1
    // INTEGER that can come back as a numeric string, so a bare `?? null` would
    // leak "8454388" into the ["integer","null"] contract field. nonNegativeInt
    // maps null→null and numeric strings→real integers.
    block_number: nonNegativeInt(first.block_number),
  };
}

export function buildSubnetMetagraph(rows, netuid, { immunityPeriod } = {}) {
  const { captured_at, block_number } = snapshotStamp(rows);
  // Drop any malformed row (formatNeuron → null) so the array only holds real
  // Neuron objects, mirroring the blocks/extrinsics feed builders; the count
  // tracks the array, so callers can rely on neuron_count === neurons.length.
  // Wrapped (not a bare `rows.map(formatNeuron)`) so Array#map's index arg
  // never lands in formatNeuron's featuredHotkeys parameter.
  const neurons = rows
    .map((row) => formatNeuron(row, undefined, immunityPeriod))
    .filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    neuron_count: neurons.length,
    captured_at,
    block_number,
    neurons,
  };
}

export function buildSubnetValidators(
  rows,
  netuid,
  { featuredHotkeys = new Set() } = {},
) {
  const { captured_at, block_number } = snapshotStamp(rows);
  // A real (if possibly empty) Set is always passed to formatNeuron here, so
  // `featured` is always present on a validator row -- unlike the metagraph/
  // neuron-detail builders above, the frontend badge needs the field even
  // when nothing is currently featured.
  const validators = rows
    .map((row) => formatNeuron(row, featuredHotkeys))
    .filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    validator_count: validators.length,
    captured_at,
    block_number,
    validators,
  };
}

export function buildNeuronDetail(row, netuid, { immunityPeriod } = {}) {
  return {
    schema_version: 1,
    netuid,
    captured_at: toIso(row?.captured_at),
    // Same D1 numeric-string coercion as snapshotStamp / buildGlobalValidators
    // (#2611): keep the top-level block_number an integer or null, never a string.
    block_number: nonNegativeInt(row?.block_number),
    neuron: formatNeuron(row, undefined, immunityPeriod),
  };
}

function primaryColdkey(coldkeys) {
  const ranked = [...coldkeys.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return ranked[0]?.[0] ?? null;
}

// The coldkey's own self-declared identity (#5234), joined by `coldkey` --
// NOT the hotkey's. `identityByColdkey` is a coldkey -> account_identity row
// Map built by the caller (empty by default, so every existing D1 call site
// below that never passes one gets a stable "no identity" shape rather than
// an omitted field). Reuses buildAccountIdentity's own has_identity/sanitize
// logic and IDENTITY_FIELDS's field list (single source of truth with the
// /accounts/{ss58}/identity artifact) rather than re-deriving it, dropping
// only that artifact's own schema_version/account (redundant here -- the
// caller already knows which coldkey this is).
function coldkeyIdentity(coldkey, identityByColdkey) {
  if (!coldkey) return null;
  const full = buildAccountIdentity(
    identityByColdkey.get(coldkey) ?? null,
    coldkey,
  );
  const identity = { has_identity: full.has_identity };
  for (const field of IDENTITY_FIELDS) identity[field] = full[field];
  identity.captured_at = full.captured_at;
  return identity;
}

// Estimated annualized yield (#2551): mutates `acc` (either a
// buildGlobalValidators per-hotkey entry or buildValidatorDetail's local
// accumulator) with one subnet-membership row's contribution to
// apy_estimate. `tempoByNetuid` is a netuid -> tempo(blocks) Map (loaded by
// the caller from subnet_hyperparams); a membership whose netuid has no
// resolvable tempo, or that holds no positive stake, is EXCLUDED from both
// the numerator and denominator -- never defaulted to an assumed tempo,
// mirroring this codebase's null-never-fabricated convention (see
// nominator_count above). stake/emission are already-coerced
// numberOrZero() results, matching every other call site in this file.
//
// Each eligible row's emission_tao (a single most-recently-captured
// per-epoch reading, see NEURON_COLUMNS) is annualized using that row's own
// subnet's tempo and projected across a full year, then accumulated in
// rao-BigInt space alongside its stake so the final ratio (finalizeApy) is
// algebraically a stake-weighted blend across every eligible membership,
// computed as one sum-of-emission / sum-of-stake division rather than an
// average of per-row ratios -- mirrors stakeTotalRao/emissionTotalRao's own
// accumulate-then-convert-once pattern.
function accumulateApyRow(acc, netuid, stake, emission, tempoByNetuid) {
  const tempo = tempoByNetuid.get(netuid);
  if (tempo == null) return; // unresolved tempo -- excluded, never defaulted
  if (!(stake > 0)) return; // zero/negative-impossible stake -- excluded
  const epochsPerYear = APY_SECONDS_PER_YEAR / (tempo * APY_SECONDS_PER_BLOCK);
  const annualizedEmission = emission * epochsPerYear;
  acc.apyNumeratorRao += toRaoBig(annualizedEmission);
  acc.apyDenominatorRao += toRaoBig(stake);
  acc.apyEligibleCount += 1;
}

// Reads the three fields accumulateApyRow above populates and produces the
// two apy_estimate* output fields. Null (never 0) when no membership had a
// resolvable tempo -- "no APY opinion" rather than "confirmed zero yield".
function finalizeApy(acc) {
  if (acc.apyEligibleCount === 0 || acc.apyDenominatorRao <= 0n) {
    return { apy_estimate: null, apy_estimate_eligible_subnet_count: 0 };
  }
  const apy =
    raoBigToTao(acc.apyNumeratorRao) / raoBigToTao(acc.apyDenominatorRao);
  return {
    apy_estimate: round9(apy),
    apy_estimate_eligible_subnet_count: acc.apyEligibleCount,
  };
}

// Realized-return windows (#7228): the lookback in days for each of the three
// backward-looking return figures. The keys index the per-hotkey baseline
// object the worker resolves from neuron_daily (see loadRealizedStakeBaselines
// in workers/data-api.mjs); the values are the human window labels the field
// names carry (1d/1w/1m). A cold/absent baseline (D1 fallback, or a hotkey with
// no neuron_daily row far enough back) leaves that window's return null.
const REALIZED_RETURN_FIELDS = [
  ["d1", "realized_return_1d"],
  ["d7", "realized_return_1w"],
  ["d30", "realized_return_1m"],
];

// One window's realized return on staked capital (#7228): the rao-exact
// fractional change between a validator's current total stake (`currentStakeRao`,
// already summed across every subnet membership in rao-BigInt space) and its
// total stake at the neuron_daily snapshot ~N days ago (`baselineStakeTao`, the
// summed baseline the worker passes in). Unlike apy_estimate (a forward-looking
// annualized projection from one epoch's emission rate), this is backward-
// looking over an actually-elapsed window -- it captures both emission-driven
// compounding and net delegation flow, since a two-snapshot comparison cannot
// separate them. Null (never 0) when no neuron_daily row exists far enough back
// (baselineStakeTao null) or the baseline stake is non-positive (a return is
// undefined with nothing staked) -- "no realized figure" vs. "confirmed zero
// return", mirroring finalizeApy's null-never-fabricated convention.
function realizedReturn(currentStakeRao, baselineStakeTao) {
  if (baselineStakeTao == null) return null;
  const baselineRao = toRaoBig(baselineStakeTao);
  if (baselineRao <= 0n) return null;
  return round9(
    raoBigToTao(currentStakeRao - baselineRao) / raoBigToTao(baselineRao),
  );
}

// Project a per-hotkey baseline object ({d1,d7,d30} of baseline total_stake_tao,
// or null/absent when the worker resolved no baselines) into the three
// realized_return_* output fields. Always returns all three keys so the
// response shape is schema-stable across every tier (a cold baseline yields
// three nulls, never omitted fields), mirroring finalizeApy.
function realizedReturns(currentStakeRao, baseline) {
  const b = baseline ?? {};
  const out = {};
  for (const [key, field] of REALIZED_RETURN_FIELDS) {
    out[field] = realizedReturn(currentStakeRao, b[key] ?? null);
  }
  return out;
}

function buildGlobalValidatorEntry(
  entry,
  identityByColdkey,
  nominatorCounts = new Map(),
  realizedStakeByHotkey = new Map(),
) {
  const avgTrust =
    entry.validatorTrustCount > 0
      ? entry.validatorTrustTotal / entry.validatorTrustCount
      : null;
  // Root (netuid 0) stake is TAO-denominated with no AMM/price exposure;
  // every other netuid's stake is that subnet's alpha token (#2550). Both
  // legs are already present in entry.subnets -- one membership row per
  // netuid, including netuid 0 when the hotkey holds root stake -- so the
  // split needs no new ingestion, just separating the existing rao-precision
  // total by whether a root membership row exists. Rao-BigInt subtraction
  // (not float) keeps it exact, mirroring stakeTotalRao's own accumulation.
  const rootSubnet = entry.subnets.find((s) => s.netuid === 0) ?? null;
  const rootStakeRao = rootSubnet ? toRaoBig(rootSubnet.stake_tao) : 0n;
  const alphaStakeRao = entry.stakeTotalRao - rootStakeRao;
  const subnets = entry.subnets
    .sort(
      (a, b) =>
        b.stake_tao - a.stake_tao ||
        b.emission_tao - a.emission_tao ||
        a.netuid - b.netuid ||
        a.uid - b.uid,
    )
    .slice(0, GLOBAL_VALIDATOR_SUBNET_LIMIT);
  const coldkey = primaryColdkey(entry.coldkeys);
  return {
    hotkey: entry.hotkey,
    featured: entry.featured === true,
    coldkey,
    coldkey_identity: coldkeyIdentity(coldkey, identityByColdkey),
    coldkey_count: entry.coldkeys.size,
    subnet_count: entry.netuids.size,
    uid_count: entry.uidCount,
    take: round(entry.take),
    total_stake_tao: roundTao(raoBigToTao(entry.stakeTotalRao)),
    root_stake_tao: roundTao(raoBigToTao(rootStakeRao)),
    alpha_stake_tao: roundTao(raoBigToTao(alphaStakeRao)),
    total_emission_tao: roundTao(raoBigToTao(entry.emissionTotalRao)),
    // #2549: from the separate validator_nominator_counts side table, joined
    // by hotkey. Null when that table has no row for this hotkey yet (cold
    // table, or a hotkey the last low-frequency scan hasn't covered) --
    // never fabricated as 0, which would misreport "confirmed zero
    // nominators" as opposed to "unknown."
    nominator_count: nominatorCounts.get(entry.hotkey) ?? null,
    ...finalizeApy(entry),
    ...realizedReturns(
      entry.stakeTotalRao,
      realizedStakeByHotkey.get(entry.hotkey),
    ),
    avg_validator_trust: round(avgTrust),
    max_validator_trust: round(entry.maxValidatorTrust),
    latest_captured_at: toIso(entry.latestCapturedAt),
    latest_block_number: entry.latestBlockNumber,
    subnets,
  };
}

function applyStakeDominance(validators) {
  // Same rao-BigInt treatment as the per-hotkey accumulation above: summing
  // every validator's already-rounded total_stake_tao (one per hotkey,
  // network-wide) with plain `+=` reintroduces the same float-compounding risk
  // this fix removed upstream. total_stake_tao is already rao-precision here
  // (roundTao'd from an exact BigInt sum), so re-deriving its rao value is exact.
  const networkStakeRao = validators.reduce(
    (sum, entry) => sum + toRaoBig(entry.total_stake_tao),
    0n,
  );
  const networkStakeTotal = raoBigToTao(networkStakeRao);
  if (!(networkStakeTotal > 0) || !Number.isFinite(networkStakeTotal)) {
    return validators.map((entry) => ({ ...entry, stake_dominance: null }));
  }
  return validators.map((entry) => ({
    ...entry,
    stake_dominance: round(
      numberOrZero(entry.total_stake_tao) / networkStakeTotal,
    ),
  }));
}

export function buildGlobalValidators(
  rows,
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    featuredHotkeys = new Set(),
    identityByColdkey = new Map(),
    // hotkey -> nominator_count (#2549), sourced from the separate
    // validator_nominator_counts side table -- see that migration's own
    // comment for why this can't be a neurons-tier column. A cold/absent
    // map (e.g. the D1-retired fallback below, which never has one) leaves
    // every entry's nominator_count null, never throws.
    nominatorCounts = new Map(),
    // netuid -> tempo(blocks) (#2551), sourced from subnet_hyperparams --
    // see accumulateApyRow's own comment for why an unresolved netuid is
    // excluded rather than defaulted. A cold/absent map leaves every entry's
    // apy_estimate null, never throws.
    tempoByNetuid = new Map(),
    // hotkey -> {d1,d7,d30} baseline total_stake_tao ~1d/1w/1m ago (#7228),
    // sourced from the neuron_daily rollup (loadRealizedStakeBaselines). A
    // cold/absent map (e.g. the D1-retired fallback below, which never has one)
    // leaves every entry's realized_return_* null, never throws.
    realizedStakeByHotkey = new Map(),
  } = {},
) {
  const normalizedSort = GLOBAL_VALIDATOR_SORTS.includes(sort)
    ? sort
    : DEFAULT_GLOBAL_VALIDATOR_SORT;
  const flooredLimit = Math.floor(Number(limit));
  // Floor the limit at 0, not 1, so an explicit limit=0 returns an empty
  // leaderboard rather than being silently bumped up to a single validator.
  // Mirrors the chain-turnover / chain-stake-flow / chain-weights (#2984) clamp.
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, GLOBAL_VALIDATOR_LIMIT_MAX))
    : GLOBAL_VALIDATOR_LIMIT_DEFAULT;
  const validatorsByHotkey = new Map();
  let latestCapturedAt = null;
  let latestBlockNumber = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const hotkey =
      typeof row?.hotkey === "string" && row.hotkey.length > 0
        ? row.hotkey
        : null;
    const netuid = nonNegativeInt(row?.netuid);
    const uid = nonNegativeInt(row?.uid);
    if (!hotkey || netuid == null || uid == null) continue;

    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
    const trust = nullableNumber(row?.validator_trust);
    const capturedAt = nullableNumber(row?.captured_at);
    const blockNumber = nonNegativeInt(row?.block_number);
    let entry = validatorsByHotkey.get(hotkey);
    if (!entry) {
      entry = {
        hotkey,
        featured: featuredHotkeys.has(hotkey),
        coldkeys: new Map(),
        netuids: new Set(),
        uidCount: 0,
        stakeTotalRao: 0n,
        emissionTotalRao: 0n,
        apyNumeratorRao: 0n,
        apyDenominatorRao: 0n,
        apyEligibleCount: 0,
        validatorTrustTotal: 0,
        validatorTrustCount: 0,
        maxValidatorTrust: null,
        latestCapturedAt: null,
        latestBlockNumber: null,
        take: null,
        subnets: [],
      };
      validatorsByHotkey.set(hotkey, entry);
    }
    // Global per-hotkey, identical across every row for this hotkey -- take
    // the first non-null value seen rather than re-deriving/overwriting.
    if (entry.take == null) {
      const take = nullableNumber(row?.take);
      if (take != null) entry.take = take;
    }
    if (typeof row?.coldkey === "string" && row.coldkey.length > 0) {
      entry.coldkeys.set(
        row.coldkey,
        (entry.coldkeys.get(row.coldkey) ?? 0) + 1,
      );
    }
    entry.netuids.add(netuid);
    entry.uidCount += 1;
    entry.stakeTotalRao += toRaoBig(stake);
    entry.emissionTotalRao += toRaoBig(emission);
    accumulateApyRow(entry, netuid, stake, emission, tempoByNetuid);
    if (trust != null) {
      entry.validatorTrustTotal += trust;
      entry.validatorTrustCount += 1;
      entry.maxValidatorTrust =
        entry.maxValidatorTrust == null
          ? trust
          : Math.max(entry.maxValidatorTrust, trust);
    }
    if (capturedAt != null) {
      if (
        entry.latestCapturedAt == null ||
        capturedAt > entry.latestCapturedAt ||
        (capturedAt === entry.latestCapturedAt &&
          blockNumber != null &&
          (entry.latestBlockNumber == null ||
            blockNumber > entry.latestBlockNumber))
      ) {
        entry.latestCapturedAt = capturedAt;
        entry.latestBlockNumber = blockNumber;
      }
      if (
        latestCapturedAt == null ||
        capturedAt > latestCapturedAt ||
        (capturedAt === latestCapturedAt &&
          blockNumber != null &&
          (latestBlockNumber == null || blockNumber > latestBlockNumber))
      ) {
        latestCapturedAt = capturedAt;
        latestBlockNumber = blockNumber;
      }
    }
    entry.subnets.push({
      netuid,
      uid,
      stake_tao: roundTao(stake),
      emission_tao: roundTao(emission),
      validator_trust: round(trust),
    });
  }

  const validators = applyStakeDominance(
    // Wrapped (not a bare `.map(buildGlobalValidatorEntry)`) so Array#map's
    // index arg never lands in buildGlobalValidatorEntry's identityByColdkey
    // parameter -- same landmine formatNeuron's own header comment documents.
    [...validatorsByHotkey.values()].map((entry) =>
      buildGlobalValidatorEntry(
        entry,
        identityByColdkey,
        nominatorCounts,
        realizedStakeByHotkey,
      ),
    ),
  ).sort(
    (a, b) =>
      validatorSortValue(b, normalizedSort) -
        validatorSortValue(a, normalizedSort) ||
      a.hotkey.localeCompare(b.hotkey),
  );

  return {
    schema_version: 1,
    sort: normalizedSort,
    limit: normalizedLimit,
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    validator_count: validators.length,
    validators: validators.slice(0, normalizedLimit),
  };
}

const GLOBAL_VALIDATOR_SORT_FIELDS = {
  total_stake: "total_stake_tao",
  total_emission: "total_emission_tao",
};

function validatorSortValue(row, key) {
  const field = GLOBAL_VALIDATOR_SORT_FIELDS[key] ?? key;
  const value = row?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

// Stable partition, not a re-sort: featured rows keep their relative order
// among themselves, and everyone else keeps theirs, so the pin only ever
// bubbles rows up -- it never re-ranks within either group.
function moveFeaturedToFront(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const featured = [];
  const rest = [];
  for (const row of rows) {
    (row?.featured === true ? featured : rest).push(row);
  }
  return featured.length === 0 ? rows : [...featured, ...rest];
}

// Featured-validator pin overlay (#5166): moves any row with featured=true to
// the front of GlobalValidatorsArtifact.validators / SubnetValidatorsArtifact.
// validators, applied ONCE at the point where the D1/Postgres tiers already
// converge (mirrors overlayPreviouslyKnownAs in src/subnet-identity-history.mjs
// -- a small pure post-processing function, not duplicated per tier). Must
// never run on an explicit, non-default sort: GlobalValidatorsArtifact carries
// `sort`, so a caller who chose e.g. total_stake keeps that exact order; the
// per-subnet artifact has no `sort` field at all (its ranking is always the
// stake-DESC default), so it always gets the pin. The `featured` flag itself
// is untouched either way -- this function only ever reorders.
export function overlayFeaturedValidators(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.validators)) {
    return data;
  }
  if (
    Object.hasOwn(data, "sort") &&
    data.sort !== DEFAULT_GLOBAL_VALIDATOR_SORT
  ) {
    return data;
  }
  return { ...data, validators: moveFeaturedToFront(data.validators) };
}

// D1 read paths shared by the REST handlers and the MCP tools (one source of
// truth). `d1` is a (sql, params) => Promise<rows[]> runner; a cold/unbound DB
// returns [] → a schema-stable empty payload.
export async function loadSubnetMetagraph(
  d1,
  netuid,
  { validatorsOnly = false } = {},
) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ?${
      validatorsOnly ? " AND validator_permit = 1" : ""
    } ORDER BY uid`,
    [netuid],
  );
  return buildSubnetMetagraph(rows, netuid);
}

export async function loadSubnetValidators(d1, netuid) {
  // Tie-break equal stake by the unique uid so the ranking is deterministic
  // across snapshot-replaced captures (without it, SQLite returns tied rows in
  // arbitrary physical order). Mirrors loadSubnetMetagraph's ORDER BY uid.
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC, uid ASC`,
    [netuid],
  );
  return buildSubnetValidators(rows, netuid);
}

// No identityByColdkey passed here (#5234): account_identity's D1 write path
// is retired -- Postgres is the only actively-written copy -- so this D1
// fallback deliberately serves a stable coldkey_identity:{has_identity:false,
// ...} shape rather than joining a frozen/stale D1 copy. The live route
// (workers/data-api.mjs's /api/v1/validators, Postgres-backed) is what
// actually joins.
export async function loadGlobalValidators(
  d1,
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  } = {},
) {
  const rows = await d1(
    "SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, " +
      "stake_tao, block_number, captured_at FROM neurons " +
      "WHERE validator_permit = 1 AND hotkey IS NOT NULL " +
      "ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC",
    [],
  );
  return buildGlobalValidators(rows, { sort, limit });
}

export async function loadNeuron(d1, netuid, uid) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  return buildNeuronDetail(rows[0] ?? null, netuid);
}

// Cross-subnet validator detail (#4334/7.1): one hotkey's validator_permit=1
// rows joined across every subnet it operates in — the single-entity
// drill-in of the /api/v1/validators leaderboard above. Same aggregate shape
// as buildGlobalValidatorEntry (rao-precision stake/emission sums, avg/max
// trust), but for one hotkey instead of a many-hotkey leaderboard, and with
// full per-subnet Neuron detail (not the leaderboard's 5-field/top-10-capped
// GlobalValidatorSubnet slice) since a detail page's whole point is the full
// per-subnet performance table.
export function buildValidatorDetail(
  rows,
  hotkey,
  {
    identityByColdkey = new Map(),
    // #2549: from the separate validator_nominator_counts side table (looked
    // up by the caller, since this function has no DB access of its own).
    // Null when that table has no row for this hotkey yet -- never fabricated
    // as 0.
    nominatorCount = null,
    // netuid -> tempo(blocks) (#2551), sourced from subnet_hyperparams. See
    // accumulateApyRow's own comment. A cold/absent map leaves apy_estimate
    // null, never throws.
    tempoByNetuid = new Map(),
    // {d1,d7,d30} baseline total_stake_tao ~1d/1w/1m ago for this hotkey
    // (#7228), from the neuron_daily rollup (loadRealizedStakeBaselines). Null
    // (the D1-retired fallback default) leaves every realized_return_* null.
    realizedStake = null,
  } = {},
) {
  const coldkeys = new Map();
  let stakeTotalRao = 0n;
  // Root (netuid 0) stake is TAO-denominated with no AMM/price exposure;
  // every other netuid's stake is that subnet's alpha token (#2550) --
  // tracked separately here since the root membership row (when present) is
  // already one of `rows`, no new ingestion needed.
  let rootStakeRao = 0n;
  let emissionTotalRao = 0n;
  // Plain object (not three separate `let`s) so it can be passed directly to
  // the shared accumulateApyRow/finalizeApy helpers buildGlobalValidators
  // also uses (#2551) -- one accumulation implementation, not duplicated.
  const apyAcc = {
    apyNumeratorRao: 0n,
    apyDenominatorRao: 0n,
    apyEligibleCount: 0,
  };
  let validatorTrustTotal = 0;
  let validatorTrustCount = 0;
  let maxValidatorTrust = null;
  let latestCapturedAt = null;
  let latestBlockNumber = null;
  let take = null;
  const subnets = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    // formatNeuron only nulls on a non-object row, and a non-object row's
    // optional-chained ?.netuid is always undefined too — so netuid == null
    // already subsumes the malformed-row case; a separate !neuron guard
    // would be unreachable dead code (mirrors #2197's removal of two
    // similarly-unreachable defensive branches).
    const netuid = nonNegativeInt(row?.netuid);
    if (netuid == null) continue;
    const neuron = formatNeuron(row);

    if (typeof row?.coldkey === "string" && row.coldkey.length > 0) {
      coldkeys.set(row.coldkey, (coldkeys.get(row.coldkey) ?? 0) + 1);
    }
    // Global per-hotkey, identical across every row here -- first non-null wins.
    if (take == null) {
      const rowTake = nullableNumber(row?.take);
      if (rowTake != null) take = rowTake;
    }
    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
    const rowStakeRao = toRaoBig(stake);
    stakeTotalRao += rowStakeRao;
    if (netuid === 0) rootStakeRao += rowStakeRao;
    emissionTotalRao += toRaoBig(emission);
    accumulateApyRow(apyAcc, netuid, stake, emission, tempoByNetuid);
    const trust = nullableNumber(row?.validator_trust);
    if (trust != null) {
      validatorTrustTotal += trust;
      validatorTrustCount += 1;
      maxValidatorTrust =
        maxValidatorTrust == null ? trust : Math.max(maxValidatorTrust, trust);
    }
    const capturedAt = nullableNumber(row?.captured_at);
    const blockNumber = nonNegativeInt(row?.block_number);
    if (
      capturedAt != null &&
      (latestCapturedAt == null ||
        capturedAt > latestCapturedAt ||
        (capturedAt === latestCapturedAt &&
          blockNumber != null &&
          (latestBlockNumber == null || blockNumber > latestBlockNumber)))
    ) {
      latestCapturedAt = capturedAt;
      latestBlockNumber = blockNumber;
    }
    subnets.push({ netuid, ...neuron });
  }

  const avgTrust =
    validatorTrustCount > 0 ? validatorTrustTotal / validatorTrustCount : null;
  subnets.sort((a, b) => a.netuid - b.netuid || a.uid - b.uid);
  const coldkey = primaryColdkey(coldkeys);

  return {
    schema_version: 1,
    hotkey,
    coldkey,
    coldkey_identity: coldkeyIdentity(coldkey, identityByColdkey),
    coldkey_count: coldkeys.size,
    subnet_count: subnets.length,
    take: round(take),
    total_stake_tao: roundTao(raoBigToTao(stakeTotalRao)),
    root_stake_tao: roundTao(raoBigToTao(rootStakeRao)),
    alpha_stake_tao: roundTao(raoBigToTao(stakeTotalRao - rootStakeRao)),
    total_emission_tao: roundTao(raoBigToTao(emissionTotalRao)),
    nominator_count: nominatorCount,
    ...finalizeApy(apyAcc),
    ...realizedReturns(stakeTotalRao, realizedStake),
    avg_validator_trust: round(avgTrust),
    max_validator_trust: round(maxValidatorTrust),
    captured_at: toIso(latestCapturedAt),
    block_number: latestBlockNumber,
    subnets,
  };
}

// No identityByColdkey passed here either -- see loadGlobalValidators' comment.
export async function loadValidatorDetail(d1, hotkey) {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS}, netuid FROM neurons WHERE hotkey = ? AND validator_permit = 1 ORDER BY netuid ASC, uid ASC`,
    [hotkey],
  );
  return buildValidatorDetail(rows, hotkey);
}

// The buildValidatorDetail fields a stake-decision comparison actually reads
// (#6035): the take rate, estimated APY, nominator count, and on-chain identity
// the delegate-selection UI (#5245) surfaces, plus the cross-subnet stake/
// emission/trust aggregates that give those numbers context. Every field is
// copied verbatim from the already-loaded detail -- nothing is recomputed here.
const VALIDATOR_COMPARISON_FIELDS = [
  "hotkey",
  "coldkey",
  "coldkey_identity",
  "take",
  "apy_estimate",
  "apy_estimate_eligible_subnet_count",
  "nominator_count",
  "total_stake_tao",
  "total_emission_tao",
  "avg_validator_trust",
  "max_validator_trust",
  "subnet_count",
];

// Place several validators side by side for a stake/delegate decision (#6035):
// project each buildValidatorDetail-shaped `detail` down to the decision-
// relevant fields above (take rate, estimated APY, nominator count, on-chain
// identity, plus supporting aggregates), preserving the caller's order. This is
// a pure READ-ONLY projection of already-loaded detail objects -- it constructs
// no transaction, references no key material, and derives nothing new from
// chain state. When `netuid` is provided (the subnet context), each row also
// carries that validator's membership row in that subnet (`subnet_context`), or
// null when the validator holds no permit there -- letting a caller weigh the
// global picture against one subnet at a time. `details` that isn't an array is
// treated as an empty comparison, mirroring the cold-safe builders above.
export function composeValidatorComparison(details, { netuid = null } = {}) {
  const list = Array.isArray(details) ? details : [];
  const validators = list.map((detail) => {
    const projected = {};
    for (const field of VALIDATOR_COMPARISON_FIELDS) {
      projected[field] = detail?.[field] ?? null;
    }
    projected.subnet_context =
      netuid == null
        ? null
        : (detail?.subnets?.find((subnet) => subnet.netuid === netuid) ?? null);
    return projected;
  });
  return {
    schema_version: 1,
    netuid,
    validator_count: validators.length,
    validators,
  };
}
