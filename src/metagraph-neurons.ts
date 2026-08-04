// Shape `neurons` rows (migration 0007; also the Postgres mirror written by
// workers/data-api.ts's handleNeuronsSync, #4771) into the per-UID metagraph
// API responses for #1304/#1305 (epic #1302). Populated by the refresh-metagraph
// cron first-party via the Bittensor SDK (#1348) -- no Taostats, no API key.
// Pure + exported for tests; the Worker handlers run the D1 or Postgres query
// and call these builders.

import { buildAccountIdentity, IDENTITY_FIELDS } from "./account-identity.ts";
import { NeuronSchema } from "../schemas-src/routes/subnet-metagraph.ts";
import {
  parseFieldsParam,
  projectRow,
  projectRows,
  unknownAgainstSchema,
  type FieldProjectionResult,
} from "./field-projection.ts";

// Page-size ceiling, single-sourced in route-limits.ts so the contract's
// published `maximum` and this route's enforcement cannot drift (#9127).
import {
  GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  GLOBAL_VALIDATOR_LIMIT_MAX,
} from "./route-limits.ts";
export { GLOBAL_VALIDATOR_LIMIT_DEFAULT, GLOBAL_VALIDATOR_LIMIT_MAX };

type Row = Record<string, unknown>;
type D1Runner = (sql: string, params: unknown[]) => Promise<Row[]>;

// --- `fields=` projection (#9082) ------------------------------------------
//
// Three routes serve this row shape -- /metagraph, /validators, and
// /neurons/{uid} -- so the projection lives here, once, rather than at the six
// REST and MCP call sites that would otherwise each grow their own copy.
//
// Resolved against NeuronSchema's own shape, NOT against the keys the rows in
// hand happen to carry. That distinction is the whole reason this route uses
// the schema resolver: `immunity_expires_at_block` and `immunity_expires_at`
// are emitted only while a neuron is inside its immunity window (formatNeuron,
// below), so on a subnet where nobody currently is, a row-union check would
// reject `fields=immunity_expires_at_block` as unsupported when it is a
// declared field of the contract. Deriving from the schema also means a field
// added to NeuronSchema is projectable the same day, with no list to update.

/** Every field of the published Neuron contract, and nothing else. */
const unknownNeuronFields = unknownAgainstSchema(NeuronSchema);

/**
 * Parse `fields` for any of the three neuron routes.
 *
 * `collection` names the rows in the unsupported-field message, so a caller
 * who asked /validators for a field it does not have is told about
 * "validators" rather than about some other route's collection.
 */
export function parseNeuronFields(
  params: URLSearchParams,
  collection: string,
): FieldProjectionResult {
  return parseFieldsParam(params, unknownNeuronFields, collection);
}

/**
 * Apply a parsed projection to whichever neuron payload this is.
 *
 * Deliberately shape-driven rather than route-driven: the three artifacts
 * differ only in where the rows live (`neurons`, `validators`, or a single
 * `neuron`), and a caller of this function should not have to say which route
 * it is. Returns the payload untouched when no projection was requested, so
 * the default response stays byte-identical.
 */
export function projectNeuronPayload<T extends Row>(
  data: T,
  fields: string[] | null | undefined,
): T {
  if (!fields || !data) return data;
  const projected: Row = { ...data };
  for (const key of ["neurons", "validators"]) {
    if (Array.isArray(projected[key])) {
      projected[key] = projectRows(projected[key] as Row[], fields);
    }
  }
  // Null is a real answer here (the UID is absent from the latest snapshot),
  // and projectRow passes it through rather than turning it into {}.
  if (Object.hasOwn(projected, "neuron")) {
    projected.neuron = projectRow(projected.neuron as Row | null, fields);
  }
  return projected as T;
}

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
const GLOBAL_VALIDATOR_SUBNET_LIMIT = 10;
const RAO_PER_TAO = 1e9;

// Bittensor's network-wide block time is a long-stable EXTERNAL protocol
// parameter (~12s) that this repo does not measure per-request -- distinct
// from any live-computed block-time distribution elsewhere in this repo
// (e.g. blocks-summary.ts's blockTimeDistribution), which would make the
// same emission_tao annualize differently on every request purely from
// block-production jitter. If a future chain upgrade changes Bittensor's
// consensus block time, this constant needs a matching update; it is a
// documented assumption apy_estimate depends on, not something this route
// verifies (#2551).
const APY_SECONDS_PER_BLOCK = 12;
// Calendar year, no leap-day adjustment -- a documented convention, not a
// protocol-derived figure. No prior art for "a year" exists elsewhere in
// this repo (src/chain-yield.ts / src/subnet-yield.ts are explicitly
// snapshot-only, never annualized) -- apy_estimate is the new precedent.
const APY_SECONDS_PER_YEAR = 365 * 24 * 60 * 60; // 31,536,000

function toIso(ms: unknown): string | null {
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

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value: unknown): number | null {
  // Guard null first: Number(null) === 0, so a null column (block_number is a
  // nullable INTEGER) would masquerade as the real chain height / netuid / uid 0
  // instead of "absent". A numeric string like "10" from D1 must still pass.
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function roundTao(value: unknown): number {
  return Math.round(numberOrZero(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Sum in rao-integer BigInt space, not float space -- summing every validator
// UID's stake_tao/emission_tao per hotkey (network-wide, unbounded) with plain
// `+=` compounds rounding error across the accumulation even when each
// individual value is itself exact (metagraphed#2922, mirrors the toRaoBig
// pattern in src/chain-yield.ts and the toRao helper proven in
// src/account-balance.ts for #2070). Convert back to TAO only once, at the
// very end. Callers always pass an already-finite numberOrZero()/roundTao()
// result, so no isFinite guard here.
function toRaoBig(tao: number): bigint {
  return BigInt(Math.round(tao * RAO_PER_TAO));
}
function raoBigToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function round(value: unknown, dp = 6): number | null {
  if (value == null || !Number.isFinite(value as number)) return null;
  const factor = 10 ** dp;
  return Math.round((value as number) * factor) / factor;
}

// 1 TAO = 1e9 rao; round yield-shaped outputs to that precision to shed
// IEEE-754 noise below the rao floor while keeping small ratios meaningful.
// Matches src/chain-yield.ts / src/subnet-yield.ts's own round9 exactly
// (apy_estimate is a sibling yield-shaped field, not a trust/take value, so
// it uses this precision convention rather than round()'s 6dp default).
function round9(value: unknown): number | null {
  if (value == null || !Number.isFinite(value as number)) return null;
  return Math.round(Number(value) * RAO_PER_TAO) / RAO_PER_TAO;
}

// Coerce a D1 0/1 INTEGER flag cell to a boolean. Numeric strings like "0"
// must not pass through Boolean(), which treats any non-empty string as true.
// Mirrors the local toD1Flag added to formatRegistration by #2487.
function toD1Flag(value: unknown): boolean {
  return Number(value) === 1;
}

interface ImmunityWindow {
  immunity_expires_at_block?: number;
  immunity_expires_at?: string | null;
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
// proven toBlockNumber / toTaoOrNull null-guards in account-events.ts
// (#2487).
// featuredHotkeys (optional) is a Set of hotkeys from the featured_validators
// side table (#5166 recorded why that's a separate
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
export function computeImmunityWindow(
  row: Row,
  neuron: Row,
  immunityPeriod: number,
): ImmunityWindow {
  if (!neuron.is_immunity_period || neuron.registered_at_block == null) {
    return {};
  }
  const expiresAtBlock =
    (neuron.registered_at_block as number) + immunityPeriod;
  const snapshotBlock = nonNegativeInt(row.block_number);
  const capturedAtMs = row.captured_at == null ? null : Number(row.captured_at);
  let expiresAt: string | null = null;
  if (
    snapshotBlock != null &&
    Number.isFinite(capturedAtMs as number) &&
    (capturedAtMs as number) > 0
  ) {
    const blocksRemaining = expiresAtBlock - snapshotBlock;
    if (blocksRemaining > 0) {
      expiresAt = toIso(
        (capturedAtMs as number) +
          blocksRemaining * APY_SECONDS_PER_BLOCK * 1000,
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
export function formatNeuron(
  row: Row | null | undefined,
  featuredHotkeys?: Set<string>,
  immunityPeriod?: number | null,
): Row | null {
  if (!row || typeof row !== "object") return null;
  const hotkey = row.hotkey ?? null;
  const neuron: Row = {
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
    neuron.featured = Boolean(hotkey && featuredHotkeys.has(hotkey as string));
  }
  if (Number.isSafeInteger(immunityPeriod) && (immunityPeriod as number) >= 0) {
    Object.assign(
      neuron,
      computeImmunityWindow(row, neuron, immunityPeriod as number),
    );
  }
  return neuron;
}

// All rows of one subnet's snapshot share the same captured_at/block_number.
function snapshotStamp(rows: Row[]): {
  captured_at: string | null;
  block_number: number | null;
} {
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

export function buildSubnetMetagraph(
  rows: Row[],
  netuid: unknown,
  { immunityPeriod }: { immunityPeriod?: number | null } = {},
): Row {
  const { captured_at, block_number } = snapshotStamp(rows);
  // Drop any malformed row (formatNeuron → null) so the array only holds real
  // Neuron objects, mirroring the blocks/extrinsics feed builders; the count
  // tracks the array, so callers can rely on neuron_count === neurons.length.
  // Wrapped (not a bare `rows.map(formatNeuron)`) so Array#map's index arg
  // never lands in formatNeuron's featuredHotkeys parameter.
  const neurons = rows
    .map((row) => formatNeuron(row, undefined, immunityPeriod))
    .filter((n): n is Row => Boolean(n));
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
  rows: Row[],
  netuid: unknown,
  {
    featuredHotkeys = new Set<string>(),
  }: { featuredHotkeys?: Set<string> } = {},
): Row {
  const { captured_at, block_number } = snapshotStamp(rows);
  // A real (if possibly empty) Set is always passed to formatNeuron here, so
  // `featured` is always present on a validator row -- unlike the metagraph/
  // neuron-detail builders above, the frontend badge needs the field even
  // when nothing is currently featured.
  const validators = rows
    .map((row) => formatNeuron(row, featuredHotkeys))
    .filter((n): n is Row => Boolean(n));
  return {
    schema_version: 1,
    netuid,
    validator_count: validators.length,
    captured_at,
    block_number,
    validators,
  };
}

export function buildNeuronDetail(
  row: Row | null | undefined,
  netuid: unknown,
  { immunityPeriod }: { immunityPeriod?: number | null } = {},
): Row {
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

function primaryColdkey(coldkeys: Map<string, number>): string | null {
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
function coldkeyIdentity(
  coldkey: string | null,
  identityByColdkey: Map<string, Row>,
): Row | null {
  if (!coldkey) return null;
  const full = buildAccountIdentity(
    identityByColdkey.get(coldkey) ?? null,
    coldkey,
  );
  const identity: Row = { has_identity: full.has_identity };
  for (const field of IDENTITY_FIELDS) identity[field] = full[field];
  identity.captured_at = full.captured_at;
  return identity;
}

interface ApyAccumulator {
  apyNumeratorRao: bigint;
  apyDenominatorRao: bigint;
  apyEligibleCount: number;
}

// Per-netuid TAO pricing for the cross-subnet sums (#9051, the Group B half
// of #8945). A neuron's stake_tao/emission_tao on any netuid != 0 are that
// subnet's ALPHA token (#2550), so summing rows across subnets used to add
// root's genuine TAO to ~128 mutually-incomparable alpha counts under a
// `_tao` name. Every cross-subnet aggregate in this file now converts each
// row through its own subnet's alpha_price_tao first (root passes through at
// 1:1 -- root stake IS TAO), the same per-netuid join #8803 established for
// account positions' delegated_tao.
//
// A netuid with no resolvable price (no subnet_snapshots row yet, or a null
// price cell) contributes NOTHING to the priced total -- never silently 1:1,
// which would quietly re-create the old bug for exactly the rows where the
// price is unknown. That exclusion is a safety valve, not an expected state:
// the economics tier carries alpha_price_tao for every subnet and
// subnet_snapshots is written from it, so a miss is a data defect. Excluding
// under-reports the total rather than mis-denominating it, which is the safe
// direction to fail in.
function priceForNetuid(
  netuid: number,
  priceByNetuid: Map<number, number | null>,
): number | null {
  if (netuid === 0) return 1;
  const price = priceByNetuid.get(netuid);
  return typeof price === "number" && Number.isFinite(price) && price >= 0
    ? price
    : null;
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
function accumulateApyRow(
  acc: ApyAccumulator,
  netuid: number,
  stake: number,
  emission: number,
  tempoByNetuid: Map<number, number>,
): void {
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
function finalizeApy(acc: ApyAccumulator): Row {
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
// in workers/data-api.ts); the values are the human window labels the field
// names carry (1d/1w/1m). A cold/absent baseline (D1 fallback, or a hotkey with
// no neuron_daily row far enough back) leaves that window's return null.
const REALIZED_RETURN_FIELDS: Array<[string, string]> = [
  ["d1", "realized_return_1d"],
  ["d7", "realized_return_1w"],
  ["d30", "realized_return_1m"],
];

// One window's realized return on staked capital (#7228): the rao-exact
// fractional change between a validator's current total stake (`currentStakeRao`,
// already summed across every subnet membership in rao-BigInt space) and its
// total stake at the newest permitted neuron_daily snapshot within a few days
// of the ~N-days-ago target date (`baselineStakeTao`, the summed baseline the
// worker passes in; the worker bounds that lookback so a stale far-older
// snapshot can never stand in, #8837). Unlike apy_estimate (a forward-looking
// annualized projection from one epoch's emission rate), this is backward-
// looking over an actually-elapsed window -- it captures both emission-driven
// compounding and net delegation flow, since a two-snapshot comparison cannot
// separate them. Null (never 0) when the worker found no permitted snapshot in
// that bounded window (baselineStakeTao null) or the baseline stake is non-positive (a return is
// undefined with nothing staked) -- "no realized figure" vs. "confirmed zero
// return", mirroring finalizeApy's null-never-fabricated convention.
function realizedReturn(
  currentStakeRao: bigint,
  baselineStakeTao: number | null,
): number | null {
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
function realizedReturns(
  currentStakeRao: bigint,
  baseline: Row | null | undefined,
): Row {
  const b = baseline ?? {};
  const out: Row = {};
  for (const [key, field] of REALIZED_RETURN_FIELDS) {
    out[field] = realizedReturn(currentStakeRao, (b[key] as number) ?? null);
  }
  return out;
}

interface ValidatorAccumEntry {
  hotkey: string;
  featured: boolean;
  coldkeys: Map<string, number>;
  netuids: Set<number>;
  uidCount: number;
  stakeTotalRao: bigint;
  emissionTotalRao: bigint;
  apyNumeratorRao: bigint;
  apyDenominatorRao: bigint;
  apyEligibleCount: number;
  validatorTrustTotal: number;
  validatorTrustCount: number;
  maxValidatorTrust: number | null;
  latestCapturedAt: number | null;
  latestBlockNumber: number | null;
  take: number | null;
  subnets: Row[];
}

function buildGlobalValidatorEntry(
  entry: ValidatorAccumEntry,
  identityByColdkey: Map<string, Row>,
  nominatorCounts: Map<string, number> = new Map(),
  realizedStakeByHotkey: Map<string, Row> = new Map(),
): Row {
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
  // Since #9051 stakeTotalRao is TAO-PRICED; root's leg passes through the
  // pricing at exactly 1:1, so subtracting the raw root row still yields the
  // priced alpha leg -- alpha_stake_tao is now genuinely TAO, the current
  // market value of the non-root delegations the priced total covers.
  const rootSubnet = entry.subnets.find((s) => s.netuid === 0) ?? null;
  const rootStakeRao = rootSubnet
    ? toRaoBig(rootSubnet.stake_tao as number)
    : 0n;
  const alphaStakeRao = entry.stakeTotalRao - rootStakeRao;
  const subnets = entry.subnets
    .sort(
      (a, b) =>
        (b.stake_tao as number) - (a.stake_tao as number) ||
        (b.emission_tao as number) - (a.emission_tao as number) ||
        (a.netuid as number) - (b.netuid as number) ||
        (a.uid as number) - (b.uid as number),
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

function applyStakeDominance(validators: Row[]): Row[] {
  // Same rao-BigInt treatment as the per-hotkey accumulation above: summing
  // every validator's already-rounded total_stake_tao (one per hotkey,
  // network-wide) with plain `+=` reintroduces the same float-compounding risk
  // this fix removed upstream. total_stake_tao is already rao-precision here
  // (roundTao'd from an exact BigInt sum), so re-deriving its rao value is exact.
  const networkStakeRao = validators.reduce(
    (sum, entry) => sum + toRaoBig(entry.total_stake_tao as number),
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

/** The explicit "there is nothing to price" map, for the cold/absent-tier
 * fallbacks that build a schema-stable empty card from zero rows. Named rather
 * than a bare `new Map()` at each call site so the intent is greppable and a
 * real caller can never reach for it by accident (#9051). */
export const NO_ALPHA_PRICES: Map<number, number | null> = new Map();

export interface BuildGlobalValidatorsOptions {
  sort?: string;
  limit?: unknown;
  /** netuid -> alpha_price_tao. REQUIRED, and deliberately not defaulted
   * (#9051): an implicit empty map would silently price nothing, which for a
   * cross-subnet sum means publishing raw alpha under a _tao name -- exactly
   * the bug this exists to fix. A caller that cannot resolve prices must say
   * so explicitly by passing an empty map, not by omitting the argument.
   *
   * Complete by construction: the economics tier carries alpha_price_tao for
   * every subnet (129/129 including root at time of writing) and
   * subnet_snapshots is written from it, so a netuid missing here is a data
   * defect, not a normal state. Such a membership is EXCLUDED from the sums,
   * which under-reports rather than mis-denominates -- the safe direction. */
  priceByNetuid: Map<number, number | null>;
  featuredHotkeys?: Set<string>;
  identityByColdkey?: Map<string, Row>;
  nominatorCounts?: Map<string, number>;
  tempoByNetuid?: Map<number, number>;
  realizedStakeByHotkey?: Map<string, Row>;
}

export function buildGlobalValidators(
  rows: Row[],
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
    featuredHotkeys = new Set<string>(),
    priceByNetuid,
    identityByColdkey = new Map<string, Row>(),
    // hotkey -> nominator_count (#2549), sourced from the separate
    // validator_nominator_counts side table -- see that migration's own
    // comment for why this can't be a neurons-tier column. A cold/absent
    // map (e.g. the D1-retired fallback below, which never has one) leaves
    // every entry's nominator_count null, never throws.
    nominatorCounts = new Map<string, number>(),
    // netuid -> tempo(blocks) (#2551), sourced from subnet_hyperparams --
    // see accumulateApyRow's own comment for why an unresolved netuid is
    // excluded rather than defaulted. A cold/absent map leaves every entry's
    // apy_estimate null, never throws.
    tempoByNetuid = new Map<number, number>(),
    // hotkey -> {d1,d7,d30} baseline total_stake_tao ~1d/1w/1m ago (#7228),
    // sourced from the neuron_daily rollup (loadRealizedStakeBaselines). A
    // cold/absent map (e.g. the D1-retired fallback below, which never has one)
    // leaves every entry's realized_return_* null, never throws.
    realizedStakeByHotkey = new Map<string, Row>(),
  }: BuildGlobalValidatorsOptions,
): Row {
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
  const validatorsByHotkey = new Map<string, ValidatorAccumEntry>();
  let latestCapturedAt: number | null = null;
  let latestBlockNumber: number | null = null;

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
    // TAO-priced accumulation (#9051): each membership row converts through
    // its own subnet's alpha price before joining the cross-subnet totals;
    // an unpriceable row lands in the residuals instead (see priceForNetuid).
    const price = priceForNetuid(netuid, priceByNetuid);
    if (price != null) {
      entry.stakeTotalRao += toRaoBig(stake * price);
      entry.emissionTotalRao += toRaoBig(emission * price);
      // Priced values in the APY blend too: Σemission/Σstake across subnets
      // is only a coherent stake-weighted rate when both sums share one
      // denomination. An unpriceable membership is excluded, matching the
      // helper's own unresolved-tempo exclusion rule.
      accumulateApyRow(
        entry,
        netuid,
        stake * price,
        emission * price,
        tempoByNetuid,
      );
    }
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
      (a.hotkey as string).localeCompare(b.hotkey as string),
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

const GLOBAL_VALIDATOR_SORT_FIELDS: Record<string, string> = {
  total_stake: "total_stake_tao",
  total_emission: "total_emission_tao",
};

function validatorSortValue(row: Row, key: string): number {
  const field = GLOBAL_VALIDATOR_SORT_FIELDS[key] ?? key;
  const value = row?.[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.NEGATIVE_INFINITY;
}

// Stable partition, not a re-sort: featured rows keep their relative order
// among themselves, and everyone else keeps theirs, so the pin only ever
// bubbles rows up -- it never re-ranks within either group.
function moveFeaturedToFront(rows: Row[]): Row[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const featured: Row[] = [];
  const rest: Row[] = [];
  for (const row of rows) {
    (row?.featured === true ? featured : rest).push(row);
  }
  return featured.length === 0 ? rows : [...featured, ...rest];
}

// Featured-validator pin overlay (#5166): moves any row with featured=true to
// the front of GlobalValidatorsArtifact.validators / SubnetValidatorsArtifact.
// validators, applied ONCE at the point where the D1/Postgres tiers already
// converge (mirrors overlayPreviouslyKnownAs in src/subnet-identity-history.ts
// -- a small pure post-processing function, not duplicated per tier). Must
// never run on an explicit, non-default sort: GlobalValidatorsArtifact carries
// `sort`, so a caller who chose e.g. total_stake keeps that exact order; the
// per-subnet artifact has no `sort` field at all (its ranking is always the
// stake-DESC default), so it always gets the pin. The `featured` flag itself
// is untouched either way -- this function only ever reorders.
export function overlayFeaturedValidators(
  data: Row | null | undefined,
): Row | null | undefined {
  if (!data || typeof data !== "object" || !Array.isArray(data.validators)) {
    return data;
  }
  if (
    Object.hasOwn(data, "sort") &&
    data.sort !== DEFAULT_GLOBAL_VALIDATOR_SORT
  ) {
    return data;
  }
  return {
    ...data,
    validators: moveFeaturedToFront(data.validators as Row[]),
  };
}

// D1 read paths shared by the REST handlers and the MCP tools (one source of
// truth). `d1` is a (sql, params) => Promise<rows[]> runner; a cold/unbound DB
// returns [] → a schema-stable empty payload.
export async function loadSubnetMetagraph(
  d1: D1Runner,
  netuid: unknown,
  { validatorsOnly = false }: { validatorsOnly?: boolean } = {},
): Promise<Row> {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ?${
      validatorsOnly ? " AND validator_permit = 1" : ""
    } ORDER BY uid`,
    [netuid],
  );
  return buildSubnetMetagraph(rows, netuid);
}

export async function loadSubnetValidators(
  d1: D1Runner,
  netuid: unknown,
): Promise<Row> {
  // Tie-break equal stake by the unique uid so the ranking is deterministic
  // across snapshot-replaced captures (without it, SQLite returns tied rows in
  // arbitrary physical order). Mirrors loadSubnetMetagraph's ORDER BY uid.
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND validator_permit = 1 ORDER BY stake_tao DESC, uid ASC`,
    [netuid],
  );
  return buildSubnetValidators(rows, netuid);
}

// netuid -> latest alpha_price_tao from the D1 subnet_snapshots mirror
// (#9051), for the shared D1 fallback loaders below -- the D1 twin of
// workers/data-api.ts's loadAlphaPricesByNetuid. Group-wise MAX join rather
// than DISTINCT ON (SQLite has neither). A cold/absent table yields an empty
// map, which prices nothing: every non-root row is excluded from the totals
// rather than being silently counted 1:1.
export async function loadD1AlphaPricesByNetuid(
  d1: D1Runner,
): Promise<Map<number, number | null>> {
  try {
    const rows = await d1(
      "SELECT s.netuid, s.alpha_price_tao FROM subnet_snapshots s " +
        "JOIN (SELECT netuid, MAX(snapshot_date) AS snapshot_date " +
        "FROM subnet_snapshots GROUP BY netuid) latest " +
        "ON latest.netuid = s.netuid AND latest.snapshot_date = s.snapshot_date",
      [],
    );
    const map = new Map<number, number | null>();
    for (const row of rows) {
      const netuid = nonNegativeInt(row?.netuid);
      if (netuid == null) continue;
      map.set(netuid, nullableNumber(row?.alpha_price_tao));
    }
    return map;
  } catch {
    return new Map();
  }
}

// No identityByColdkey passed here (#5234): account_identity's D1 write path
// is retired -- Postgres is the only actively-written copy -- so this D1
// fallback deliberately serves a stable coldkey_identity:{has_identity:false,
// ...} shape rather than joining a frozen/stale D1 copy. The live route
// (workers/data-api.ts's /api/v1/validators, Postgres-backed) is what
// actually joins.
export async function loadGlobalValidators(
  d1: D1Runner,
  {
    sort = DEFAULT_GLOBAL_VALIDATOR_SORT,
    limit = GLOBAL_VALIDATOR_LIMIT_DEFAULT,
  }: { sort?: string; limit?: unknown } = {},
): Promise<Row> {
  const [rows, priceByNetuid] = await Promise.all([
    d1(
      "SELECT netuid, uid, hotkey, coldkey, validator_trust, emission_tao, " +
        "stake_tao, block_number, captured_at FROM neurons " +
        "WHERE validator_permit = 1 AND hotkey IS NOT NULL " +
        "ORDER BY hotkey ASC, stake_tao DESC, netuid ASC, uid ASC",
      [],
    ),
    loadD1AlphaPricesByNetuid(d1),
  ]);
  return buildGlobalValidators(rows, { sort, limit, priceByNetuid });
}

export async function loadNeuron(
  d1: D1Runner,
  netuid: unknown,
  uid: unknown,
): Promise<Row> {
  const rows = await d1(
    `SELECT ${NEURON_COLUMNS} FROM neurons WHERE netuid = ? AND uid = ? LIMIT 1`,
    [netuid, uid],
  );
  return buildNeuronDetail(rows[0] ?? null, netuid);
}

export interface BuildValidatorDetailOptions {
  identityByColdkey?: Map<string, Row>;
  /** netuid -> alpha_price_tao. REQUIRED, and deliberately not defaulted
   * (#9051): an implicit empty map would silently price nothing, which for a
   * cross-subnet sum means publishing raw alpha under a _tao name -- exactly
   * the bug this exists to fix. A caller that cannot resolve prices must say
   * so explicitly by passing an empty map, not by omitting the argument.
   *
   * Complete by construction: the economics tier carries alpha_price_tao for
   * every subnet (129/129 including root at time of writing) and
   * subnet_snapshots is written from it, so a netuid missing here is a data
   * defect, not a normal state. Such a membership is EXCLUDED from the sums,
   * which under-reports rather than mis-denominates -- the safe direction. */
  priceByNetuid: Map<number, number | null>;
  nominatorCount?: number | null;
  tempoByNetuid?: Map<number, number>;
  realizedStake?: Row | null;
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
  rows: Row[],
  hotkey: unknown,
  {
    identityByColdkey = new Map<string, Row>(),
    priceByNetuid,
    // #2549: from the separate validator_nominator_counts side table (looked
    // up by the caller, since this function has no DB access of its own).
    // Null when that table has no row for this hotkey yet -- never fabricated
    // as 0.
    nominatorCount = null,
    // netuid -> tempo(blocks) (#2551), sourced from subnet_hyperparams. See
    // accumulateApyRow's own comment. A cold/absent map leaves apy_estimate
    // null, never throws.
    tempoByNetuid = new Map<number, number>(),
    // {d1,d7,d30} baseline total_stake_tao ~1d/1w/1m ago for this hotkey
    // (#7228), from the neuron_daily rollup (loadRealizedStakeBaselines). Null
    // (the D1-retired fallback default) leaves every realized_return_* null.
    realizedStake = null,
  }: BuildValidatorDetailOptions,
): Row {
  const coldkeys = new Map<string, number>();
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
  const apyAcc: ApyAccumulator = {
    apyNumeratorRao: 0n,
    apyDenominatorRao: 0n,
    apyEligibleCount: 0,
  };
  let validatorTrustTotal = 0;
  let validatorTrustCount = 0;
  let maxValidatorTrust: number | null = null;
  let latestCapturedAt: number | null = null;
  let latestBlockNumber: number | null = null;
  let take: number | null = null;
  const subnets: Row[] = [];

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
    // TAO-priced accumulation (#9051), mirroring buildGlobalValidators: each
    // membership converts through its own subnet's alpha price; an
    // unpriceable one lands in the residuals. Root prices at exactly 1, so
    // rootStakeRao stays the raw root leg either way.
    const price = priceForNetuid(netuid, priceByNetuid);
    if (price != null) {
      const rowStakeRao = toRaoBig(stake * price);
      stakeTotalRao += rowStakeRao;
      if (netuid === 0) rootStakeRao += rowStakeRao;
      emissionTotalRao += toRaoBig(emission * price);
      accumulateApyRow(
        apyAcc,
        netuid,
        stake * price,
        emission * price,
        tempoByNetuid,
      );
    }
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
  subnets.sort(
    (a, b) =>
      (a.netuid as number) - (b.netuid as number) ||
      (a.uid as number) - (b.uid as number),
  );
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
export async function loadValidatorDetail(
  d1: D1Runner,
  hotkey: unknown,
): Promise<Row> {
  const [rows, priceByNetuid] = await Promise.all([
    d1(
      `SELECT ${NEURON_COLUMNS}, netuid FROM neurons WHERE hotkey = ? AND validator_permit = 1 ORDER BY netuid ASC, uid ASC`,
      [hotkey],
    ),
    loadD1AlphaPricesByNetuid(d1),
  ]);
  return buildValidatorDetail(rows, hotkey, { priceByNetuid });
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
export function composeValidatorComparison(
  details: unknown,
  { netuid = null }: { netuid?: unknown } = {},
): Row {
  const list = Array.isArray(details) ? (details as Row[]) : [];
  const validators = list.map((detail) => {
    const projected: Row = {};
    for (const field of VALIDATOR_COMPARISON_FIELDS) {
      projected[field] = detail?.[field] ?? null;
    }
    projected.subnet_context =
      netuid == null
        ? null
        : ((detail?.subnets as Row[] | undefined)?.find(
            (subnet) => subnet.netuid === netuid,
          ) ?? null);
    return projected;
  });
  return {
    schema_version: 1,
    netuid,
    validator_count: validators.length,
    validators,
  };
}
