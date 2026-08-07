// Subnet concentration / decentralization metrics (#2106): pure statistics over a
// subnet's per-UID value distribution (stake_tao, emission_tao from the live
// `neurons` D1 tier). Every function is pure + exported for unit tests; the Worker
// does the D1 read + envelope. Null-safe by design: an empty / all-zero
// distribution yields a schema-stable `null` block (never throws), matching the
// live metagraph tiers the entity handlers already own.

import { DAY_MS } from "../workers/config.ts";

// The neurons-tier columns the concentration handler reads — the D1 read contract
// for buildConcentration (mirrors BLOCK_READ_COLUMNS / EXTRINSIC_READ_COLUMNS). Kept
// here next to its consumer so the Worker handler stays a thin SELECT.
export const CONCENTRATION_READ_COLUMNS =
  "stake_tao, emission_tao, coldkey, validator_permit, captured_at";

// Top-K%-of-holders cutoffs reported as cumulative shares of the total.
const TOP_PERCENTILES = [1, 5, 10, 20];

// Round a ratio/amount to a stable decimal precision; null/non-finite → null so the
// schema stays `number|null` and JSON never carries a long floating-point tail.
function round(value: number | null | undefined, dp = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// Round a 0..1 concentration ratio (gini, hhi, normalized variants, top-K share)
// WITHOUT letting a sub-perfect value round up to an exact 1 — a near-monopoly
// that holds 99.99996% must not display as a perfect 1.0 ("total concentration"),
// the same anti-overstatement guard the turnover/chain-activity ratios apply. A
// genuine ratio of exactly 1 (e.g. a single holder's 100% share) keeps 1.0.
function roundRatio(value: number | null | undefined, dp = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// Sum in rao-integer BigInt space, not float space -- summing potentially
// thousands of network-wide stake_tao/emission_tao floats (per controlling
// entity, or as a distribution total) with plain `+=` compounds rounding error
// across the accumulation even when each individual value is itself exact
// (metagraphed#2922, mirrors the toRaoBig pattern in src/chain-yield.ts and
// src/metagraph-neurons.ts). Convert back to TAO only once, at the very end.
function toRaoBig(taoValue: unknown): bigint {
  const n = typeof taoValue === "number" ? taoValue : Number(taoValue);
  return Number.isFinite(n) ? BigInt(Math.round(n * 1e9)) : 0n;
}
function raoBigToTao(rao: bigint): number {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

interface CaptureStamp {
  ms: number;
  value: string;
}

function epochMsStamp(ms: number): CaptureStamp | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

function captureStamp(value: unknown): CaptureStamp | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      return epochMsStamp(Number(value));
    }
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return { ms, value };
    return null;
  }
  if (typeof value === "number") {
    return epochMsStamp(value);
  }
  return null;
}

// Coerce a raw column array to the finite, strictly-positive values that actually
// make up a distribution. Zero / negative / NaN / null entries carry no share and
// are dropped, so `holders` counts real participants and the shares sum to 1.
function positiveValues(values: unknown[]): number[] {
  const out: number[] = [];
  for (const raw of values) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

// Gini coefficient via the sorted-rank formula
//   G = (2·Σ i·x₍ᵢ₎) / (n·Σx) − (n+1)/n,  x ascending, i = 1..n.
// 0 = perfectly equal, →1 = one holder owns everything. A lone holder is 0 by this
// definition (no inequality between a single point); HHI/Nakamoto capture that the
// single holder is nonetheless maximally concentrated. Tiny negative FP drift on a
// uniform distribution is clamped to 0.
function gini(ascending: number[], total: number): number {
  const n = ascending.length;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * ascending[i];
  const g = (2 * weighted) / (n * total) - (n + 1) / n;
  return g < 0 ? 0 : g;
}

// Herfindahl–Hirschman Index: Σ shareᵢ². Ranges [1/n, 1]; 1 = monopoly.
function hhi(values: number[], total: number): number {
  let sum = 0;
  for (const v of values) {
    const share = v / total;
    sum += share * share;
  }
  return sum;
}

// Normalize HHI to [0,1] independent of holder count: (H − 1/n)/(1 − 1/n). A single
// holder (n = 1) is defined as 1 (maximally concentrated).
function hhiNormalized(h: number, n: number): number {
  if (n <= 1) return 1;
  return (h - 1 / n) / (1 - 1 / n);
}

// Nakamoto coefficient: the fewest top holders whose cumulative share strictly
// exceeds 50% — the smallest set that could collude to control the subnet.
function nakamoto(descending: number[], total: number): number {
  const half = total / 2;
  let acc = 0;
  let count = 0;
  for (const value of descending) {
    acc += value;
    count += 1;
    if (acc > half) break;
  }
  return count;
}

interface TopShares {
  [key: `top_${number}pct_share`]: number | null;
}

// Cumulative share held by the top ⌈n·p/100⌉ holders for each p in TOP_PERCENTILES
// (at least one holder). One prefix-sum pass, then each cutoff is an O(1) read.
function topShares(descending: number[], total: number): TopShares {
  const n = descending.length;
  const prefix = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += descending[i];
    prefix[i] = acc;
  }
  const out: TopShares = {};
  for (const p of TOP_PERCENTILES) {
    const k = Math.max(1, Math.ceil((n * p) / 100));
    out[`top_${p}pct_share`] = roundRatio(prefix[k - 1] / total);
  }
  return out;
}

interface Entropy {
  bits: number;
  normalized: number;
}

// Shannon entropy of the share distribution (bits) + its normalization against the
// log2(n) maximum: 1 = perfectly uniform, →0 = fully concentrated.
function entropy(values: number[], total: number): Entropy {
  let bits = 0;
  for (const v of values) {
    const share = v / total;
    if (share > 0) bits -= share * Math.log2(share);
  }
  const normalized = values.length > 1 ? bits / Math.log2(values.length) : 0;
  return { bits, normalized };
}

export interface ConcentrationScorecard extends TopShares {
  holders: number;
  total: number | null;
  gini: number | null;
  hhi: number | null;
  hhi_normalized: number | null;
  nakamoto_coefficient: number;
  entropy: number | null;
  entropy_normalized: number | null;
}

// Full concentration scorecard for one value column, or `null` when there is no
// positive distribution to measure (cold store / empty subnet / all-zero column).
export function computeConcentration(
  values: unknown[] | null | undefined,
): ConcentrationScorecard | null {
  const positives = positiveValues(Array.isArray(values) ? values : []);
  const holders = positives.length;
  if (holders === 0) return null;
  // The distribution total is the ratio denominator for every metric below
  // (gini/hhi/entropy/topShares) -- summing potentially thousands of holders'
  // values in rao-BigInt space, not plain float `+=`, keeps it exact (#2922).
  const total = raoBigToTao(
    positives.reduce((sum, v) => sum + toRaoBig(v), 0n),
  );
  if (total <= 0) return null;
  const ascending = [...positives].sort((a, b) => a - b);
  const descending = [...positives].sort((a, b) => b - a);
  const h = hhi(descending, total);
  const { bits, normalized } = entropy(descending, total);
  return {
    holders,
    total: round(total, 4),
    gini: roundRatio(gini(ascending, total)),
    hhi: roundRatio(h),
    hhi_normalized: roundRatio(hhiNormalized(h, holders)),
    nakamoto_coefficient: nakamoto(descending, total),
    ...topShares(descending, total),
    entropy: round(bits),
    entropy_normalized: roundRatio(normalized),
  };
}

// Collapse a subnet's UID rows into one holder per controlling entity (coldkey),
// summing stake + emission across all of an entity's hotkeys. A row with no
// coldkey becomes its own singleton entity (a fresh object key), so the entity
// count never under-counts unknown owners. Sums in rao-BigInt space per entity
// (network-wide, potentially thousands of UIDs collapsing into one coldkey's
// total) and converts to TAO once per entity, not per row (#2922). Returns
// per-entity value arrays + the distinct-entity count, all consistent.
interface EntityGroups {
  stake: number[];
  emission: number[];
  count: number;
}

function groupByEntity(rows: Array<Record<string, unknown>>): EntityGroups {
  const stakeRao = new Map<string | object, bigint>();
  const emissionRao = new Map<string | object, bigint>();
  for (const row of rows) {
    const hasColdkey =
      typeof row?.coldkey === "string" && row.coldkey.length > 0;
    const key: string | object = hasColdkey ? (row.coldkey as string) : {};
    stakeRao.set(key, (stakeRao.get(key) ?? 0n) + toRaoBig(row?.stake_tao));
    emissionRao.set(
      key,
      (emissionRao.get(key) ?? 0n) + toRaoBig(row?.emission_tao),
    );
  }
  return {
    stake: [...stakeRao.values()].map(raoBigToTao),
    emission: [...emissionRao.values()].map(raoBigToTao),
    count: stakeRao.size,
  };
}

// Shape the neurons-tier rows for one subnet into the concentration artifact —
// three lenses over the same snapshot:
//   • per-UID         → `stake`, `emission`
//   • per-ENTITY      → `entity_stake`, `entity_emission` (coldkeys collapsed, the
//                       TRUE control distribution once an operator's many hotkeys
//                       count as one holder) + `entity_count` / `uids_per_entity`
//   • consensus power → `validator_stake` (only validator-permit UIDs)
// Null-safe on junk/sparse rows — an empty array yields a schema-stable zero
// (every metric block null).
export interface ConcentrationResult {
  schema_version: 1;
  netuid: number;
  neuron_count: number;
  entity_count: number;
  uids_per_entity: number | null;
  captured_at: string | null;
  stake: ConcentrationScorecard | null;
  emission: ConcentrationScorecard | null;
  entity_stake: ConcentrationScorecard | null;
  entity_emission: ConcentrationScorecard | null;
  validator_stake: ConcentrationScorecard | null;
}

export function buildConcentration(
  rows: Array<Record<string, unknown>> | null | undefined,
  netuid: number,
): ConcentrationResult {
  const list = Array.isArray(rows) ? rows : [];
  // The rows share one cron capture, but don't assume an order — take the newest.
  let capturedAt: CaptureStamp | null = null;
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
  }
  const entities = groupByEntity(list);
  const validatorStake = list
    .filter((row) => Number(row?.validator_permit) === 1)
    .map((row) => row?.stake_tao);
  return {
    schema_version: 1,
    netuid,
    neuron_count: list.length,
    entity_count: entities.count,
    // UIDs per controlling entity — a Sybil/consolidation signal (1.0 = every UID
    // a distinct owner; higher = fewer operators each running many hotkeys).
    uids_per_entity:
      entities.count > 0 ? round(list.length / entities.count, 4) : null,
    captured_at: capturedAt?.value ?? null,
    stake: computeConcentration(list.map((row) => row?.stake_tao)),
    emission: computeConcentration(list.map((row) => row?.emission_tao)),
    entity_stake: computeConcentration(entities.stake),
    entity_emission: computeConcentration(entities.emission),
    validator_stake: computeConcentration(validatorStake),
  };
}

// ---- Network-wide concentration (#2106): the same lenses, every subnet -----
// The neurons-tier columns the network concentration handler reads — like
// CONCENTRATION_READ_COLUMNS but with `netuid`, so the artifact can report how
// many subnets the current snapshot spans.
export const CHAIN_CONCENTRATION_READ_COLUMNS =
  "stake_tao, emission_tao, coldkey, validator_permit, netuid, captured_at";

// Network analog of buildConcentration: the SAME five lenses computed over EVERY
// subnet's neurons at once. The entity lenses (entity_stake / entity_emission)
// collapse an operator's hotkeys ACROSS subnets into one holder, so this is the
// true network-level control distribution — one operator running validators in
// ten subnets counts once, not ten times (the genuinely new measurement a
// per-subnet view can't give). `subnet_count` reports how many subnets the
// snapshot spans. Null-safe: an empty array yields a schema-stable zero (every
// metric block null), matching buildConcentration.
export interface ChainConcentrationResult {
  schema_version: 1;
  subnet_count: number;
  neuron_count: number;
  entity_count: number;
  uids_per_entity: number | null;
  captured_at: string | null;
  stake: ConcentrationScorecard | null;
  emission: ConcentrationScorecard | null;
  entity_stake: ConcentrationScorecard | null;
  entity_emission: ConcentrationScorecard | null;
  validator_stake: ConcentrationScorecard | null;
}

export function buildChainConcentration(
  rows: Array<Record<string, unknown>> | null | undefined,
): ChainConcentrationResult {
  const list = Array.isArray(rows) ? rows : [];
  // One cron capture underlies the rows, but don't assume order — take the newest.
  let capturedAt: CaptureStamp | null = null;
  const netuids = new Set<number>();
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const rawNetuid = row?.netuid;
    if (rawNetuid != null) {
      // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
      if (typeof rawNetuid === "string" && rawNetuid.trim() === "") continue;
      const netuid = Number(rawNetuid);
      // guard the coercion: a non-numeric cell must not count as subnet 0.
      if (Number.isInteger(netuid) && netuid >= 0) netuids.add(netuid);
    }
  }
  const entities = groupByEntity(list);
  const validatorStake = list
    .filter((row) => Number(row?.validator_permit) === 1)
    .map((row) => row?.stake_tao);
  return {
    schema_version: 1,
    subnet_count: netuids.size,
    neuron_count: list.length,
    entity_count: entities.count,
    // UIDs per controlling entity network-wide — a consolidation signal (1.0 =
    // every UID a distinct owner; higher = fewer operators each running many).
    uids_per_entity:
      entities.count > 0 ? round(list.length / entities.count, 4) : null,
    captured_at: capturedAt?.value ?? null,
    stake: computeConcentration(list.map((row) => row?.stake_tao)),
    emission: computeConcentration(list.map((row) => row?.emission_tao)),
    entity_stake: computeConcentration(entities.stake),
    entity_emission: computeConcentration(entities.emission),
    validator_stake: computeConcentration(validatorStake),
  };
}

// Shared D1 loader (mirrors handleChainConcentration + loadSubnetConcentration):
// read EVERY subnet's neurons in one pass, no netuid filter, and shape them into
// the network concentration artifact.
export async function loadChainConcentration(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
): Promise<ChainConcentrationResult> {
  const rows = await d1(
    `SELECT ${CHAIN_CONCENTRATION_READ_COLUMNS} FROM neurons`,
    [],
  );
  return buildChainConcentration(rows);
}

// ---- Cross-subnet concentration ranking (#9717) ----------------------------
// "Which subnets spread their rewards widely?" -- the question a miner screening
// the network actually asks, and the one nothing answered in a single call.
//
// The two halves already existed and were never joined: buildConcentration
// computes the scorecard for ONE subnet, and buildChainConcentration reads EVERY
// subnet's neurons and then collapses them into a single network aggregate,
// discarding the per-subnet structure sitting in the rows. This groups that same
// read by netuid and runs buildConcentration on each group -- the SAME function
// /api/v1/subnets/{netuid}/concentration serves, so a subnet's row here and its
// own detail route agree BY CONSTRUCTION rather than by two implementations
// staying in step. Ranking off a SQL reimplementation of gini/nakamoto would
// agree until it quietly did not.
//
// One lens per response, flattened. Five scorecards x ~129 subnets is a payload
// nobody asked for; the caller wants one ordering of one measure, and a flat row
// is what a sort and a `fields` projection can act on.

/** The distributions a caller can rank subnets by. */
export const CONCENTRATION_LENSES = [
  "emission",
  "stake",
  "entity_emission",
  "entity_stake",
  "validator_stake",
] as const;
export type ConcentrationLens = (typeof CONCENTRATION_LENSES)[number];
export const DEFAULT_CONCENTRATION_LENS: ConcentrationLens = "emission";

/**
 * Sort keys, all reading off the flattened scorecard.
 *
 * `nakamoto_coefficient` is the default because it answers the screening
 * question most directly -- how many entities it takes to control the majority
 * of the distribution -- and it is an integer count rather than a ratio, so
 * "9 vs 1" is legible where "gini 0.658 vs 0.968" is not.
 */
export const CONCENTRATION_RANKING_SORTS = [
  "nakamoto_coefficient",
  "gini",
  "holders",
  "top_1pct_share",
  "total",
  "netuid",
] as const;
export type ConcentrationRankingSort =
  (typeof CONCENTRATION_RANKING_SORTS)[number];
export const DEFAULT_CONCENTRATION_RANKING_SORT: ConcentrationRankingSort =
  "nakamoto_coefficient";

/**
 * Which direction reads as "most widely spread first" for each key.
 *
 * Stated per key rather than left to the caller's `order`, because the useful
 * default differs by measure and getting it wrong inverts the answer: a high
 * nakamoto coefficient means widely shared, while a high gini means the
 * opposite. `order` still overrides.
 */
const WIDEST_FIRST: Record<ConcentrationRankingSort, "asc" | "desc"> = {
  nakamoto_coefficient: "desc",
  gini: "asc",
  holders: "desc",
  top_1pct_share: "asc",
  total: "desc",
  netuid: "asc",
};

export interface ConcentrationRankingQuery {
  lens: ConcentrationLens;
  sort: ConcentrationRankingSort;
  order: "asc" | "desc" | null;
  limit: number;
}

/**
 * Parse `?lens/sort/order/limit` for the ranking route.
 *
 * ONE parser, because two callers need the answer and they must not disagree:
 * the api.ts handler parses to turn a bad value into a 400 before any read
 * happens, and the data-api handler parses to apply it. Two implementations of
 * "what does limit=0 mean" is exactly the drift this route cannot afford.
 *
 * `order` stays null when unset rather than defaulting here — the builder picks
 * the widest-first direction per sort key, and a default chosen at parse time
 * would flatten that into one direction for every key.
 */
export function parseConcentrationRankingQuery(
  params: URLSearchParams,
  { limitDefault, limitMax }: { limitDefault: number; limitMax: number },
):
  | ConcentrationRankingQuery
  | { error: { parameter: string; message: string } } {
  const lens = params.get("lens") || DEFAULT_CONCENTRATION_LENS;
  if (!CONCENTRATION_LENSES.includes(lens as ConcentrationLens)) {
    return {
      error: {
        parameter: "lens",
        message: `"${lens}" is not a supported lens. Supported: ${CONCENTRATION_LENSES.join(", ")}.`,
      },
    };
  }
  const sort = params.get("sort") || DEFAULT_CONCENTRATION_RANKING_SORT;
  if (!CONCENTRATION_RANKING_SORTS.includes(sort as ConcentrationRankingSort)) {
    return {
      error: {
        parameter: "sort",
        message: `"${sort}" is not a supported sort. Supported: ${CONCENTRATION_RANKING_SORTS.join(", ")}.`,
      },
    };
  }
  const rawOrder = params.get("order");
  if (rawOrder != null && rawOrder !== "asc" && rawOrder !== "desc") {
    return {
      error: {
        parameter: "order",
        message: `"${rawOrder}" is not a supported order. Supported: asc, desc.`,
      },
    };
  }
  const rawLimit = params.get("limit");
  let limit = limitDefault;
  if (rawLimit != null) {
    // Rejected rather than clamped: a caller who asked for 5000 and silently
    // received 512 has a truncated ranking they believe is complete.
    const parsed = Number(rawLimit);
    if (
      !/^\d+$/.test(rawLimit.trim()) ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > limitMax
    ) {
      return {
        error: {
          parameter: "limit",
          message: `limit must be an integer between 1 and ${limitMax}.`,
        },
      };
    }
    limit = parsed;
  }
  return {
    lens: lens as ConcentrationLens,
    sort: sort as ConcentrationRankingSort,
    order: rawOrder,
    limit,
  };
}

export interface SubnetConcentrationRow extends TopShares {
  netuid: number;
  neuron_count: number;
  entity_count: number;
  uids_per_entity: number | null;
  holders: number | null;
  total: number | null;
  gini: number | null;
  hhi: number | null;
  hhi_normalized: number | null;
  nakamoto_coefficient: number | null;
  entropy: number | null;
  entropy_normalized: number | null;
  /**
   * True when the chosen lens had no positive distribution on this subnet, so
   * every metric above is null. Published rather than left to be inferred from
   * the nulls: "nobody earned anything measurable here" and "we did not measure"
   * are different facts, and a caller ranking subnets must be able to tell them
   * apart without guessing.
   */
  unmeasured: boolean;
}

export interface SubnetConcentrationRankingResult {
  schema_version: 1;
  lens: ConcentrationLens;
  sort: ConcentrationRankingSort;
  order: "asc" | "desc";
  subnet_count: number;
  measured_subnet_count: number;
  returned: number;
  limit: number;
  neuron_count: number;
  captured_at: string | null;
  /**
   * Dimension-free network facts only. A median of a ratio is comparable across
   * subnets; a SUM of per-subnet alpha is not, because each subnet's alpha is a
   * different token -- the same rule /chain/holders states for total_alpha.
   */
  network: {
    median_gini: number | null;
    median_nakamoto_coefficient: number | null;
    median_top_1pct_share: number | null;
    single_holder_subnet_count: number;
  };
  subnets: SubnetConcentrationRow[];
}

/** Median of a numeric sample, or null when the sample is empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Flatten one subnet's chosen lens into a rankable row. */
function rankingRow(
  result: ConcentrationResult,
  lens: ConcentrationLens,
): SubnetConcentrationRow {
  const card = result[lens];
  const shell = {
    netuid: result.netuid,
    neuron_count: result.neuron_count,
    entity_count: result.entity_count,
    uids_per_entity: result.uids_per_entity,
  };
  if (!card) {
    return {
      ...shell,
      holders: null,
      total: null,
      gini: null,
      hhi: null,
      hhi_normalized: null,
      nakamoto_coefficient: null,
      top_1pct_share: null,
      top_5pct_share: null,
      top_10pct_share: null,
      top_20pct_share: null,
      entropy: null,
      entropy_normalized: null,
      unmeasured: true,
    };
  }
  const { holders, total, gini: g, hhi: h, ...rest } = card;
  return {
    ...shell,
    holders,
    total,
    gini: g,
    hhi: h,
    ...rest,
    unmeasured: false,
  };
}

export function buildSubnetConcentrationRanking(
  rows: Array<Record<string, unknown>> | null | undefined,
  {
    lens = DEFAULT_CONCENTRATION_LENS,
    sort = DEFAULT_CONCENTRATION_RANKING_SORT,
    order,
    limit,
  }: {
    lens?: ConcentrationLens;
    sort?: ConcentrationRankingSort;
    order?: "asc" | "desc" | null;
    limit: number;
  },
): SubnetConcentrationRankingResult {
  const list = Array.isArray(rows) ? rows : [];

  let capturedAt: CaptureStamp | null = null;
  const byNetuid = new Map<number, Array<Record<string, unknown>>>();
  for (const row of list) {
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const raw = row?.netuid;
    if (raw == null) continue;
    // Blank D1 cells coerce via Number("") -> 0; a non-numeric cell must not
    // land in subnet 0's group. Same guard buildChainConcentration applies.
    if (typeof raw === "string" && raw.trim() === "") continue;
    const netuid = Number(raw);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    const group = byNetuid.get(netuid);
    if (group) group.push(row);
    else byNetuid.set(netuid, [row]);
  }

  const subnets = [...byNetuid.entries()].map(([netuid, group]) =>
    rankingRow(buildConcentration(group, netuid), lens),
  );

  const direction = order ?? WIDEST_FIRST[sort];
  const factor = direction === "desc" ? -1 : 1;
  subnets.sort((a, b) => {
    // A subnet whose lens has no positive distribution sorts LAST in EITHER
    // direction. Letting it ride its nulls would put it at the top of an
    // ascending gini ranking, reading as the most perfectly equal subnet on the
    // network when in fact nothing was measured -- the same rule /chain/holders
    // states for an uncomputable share.
    if (a.unmeasured !== b.unmeasured) return a.unmeasured ? 1 : -1;
    const left = a[sort];
    const right = b[sort];
    if (left != null && right != null && left !== right) {
      return ((left as number) - (right as number)) * factor;
    }
    return a.netuid - b.netuid;
  });

  const measured = subnets.filter((row) => !row.unmeasured);
  const page = subnets.slice(0, limit);
  return {
    schema_version: 1,
    lens,
    sort,
    order: direction,
    subnet_count: subnets.length,
    measured_subnet_count: measured.length,
    returned: page.length,
    limit,
    neuron_count: list.length,
    captured_at: capturedAt?.value ?? null,
    network: {
      median_gini: round(
        median(
          measured
            .map((row) => row.gini)
            .filter((value): value is number => value != null),
        ),
      ),
      median_nakamoto_coefficient: median(
        measured
          .map((row) => row.nakamoto_coefficient)
          .filter((value): value is number => value != null),
      ),
      median_top_1pct_share: round(
        median(
          measured
            .map((row) => row.top_1pct_share)
            .filter((value): value is number => value != null),
        ),
      ),
      // One entity taking the whole lens: the strongest single signal that a
      // subnet is not worth a newcomer's registration fee.
      single_holder_subnet_count: measured.filter((row) => row.holders === 1)
        .length,
    },
    subnets: page,
  };
}

// ---- Concentration HISTORY (decentralization over time) --------------------
// Per-day concentration from the dated neuron_daily rollup, so a subnet's
// centralization trend (is power consolidating?) is chartable. Windows are
// bounded to a chartable range because each day needs its full per-UID
// distribution (concentration can't be a cheap SQL GROUP BY like the structural
// history) — a row cap then guards an unexpectedly large subnet.
export const CONCENTRATION_HISTORY_WINDOWS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const DEFAULT_CONCENTRATION_HISTORY_WINDOW = "30d";
// Safety valve on the raw per-UID read (≈256 UIDs × 90d ≈ 23k; this leaves head
// room and the builder drops a truncated oldest day so every point is complete).
export const CONCENTRATION_HISTORY_ROW_CAP = 50_000;

export type ConcentrationHistoryWindowResult =
  | { label: string; days: number }
  | { error: { parameter: string; message: string } };

// Parse ?window for the history route — a deliberately smaller set than the
// structural history (no 1y/all) so the raw read stays bounded. Returns
// {label, days} or {error:{parameter,message}} (the analyticsQueryError shape).
export function parseConcentrationHistoryWindow(
  value: unknown,
): ConcentrationHistoryWindowResult {
  const v =
    typeof value === "string" && value
      ? value
      : DEFAULT_CONCENTRATION_HISTORY_WINDOW;
  if (!Object.prototype.hasOwnProperty.call(CONCENTRATION_HISTORY_WINDOWS, v)) {
    return {
      error: {
        parameter: "window",
        message: `window must be one of: ${Object.keys(CONCENTRATION_HISTORY_WINDOWS).join(", ")}`,
      },
    };
  }
  return { label: v, days: CONCENTRATION_HISTORY_WINDOWS[v] };
}

export interface ConcentrationHistoryPoint {
  snapshot_date: string;
  neuron_count: number;
  stake_gini: number | null;
  stake_nakamoto_coefficient: number | null;
  stake_top_10pct_share: number | null;
  emission_gini: number | null;
  emission_nakamoto_coefficient: number | null;
  emission_top_10pct_share: number | null;
}

// Project one day's per-UID rows to a flat, chartable concentration point. Flat
// (not nested) fields keep a time series trivial to plot. Null-safe — a cold/empty
// day yields null metrics, never throws.
function concentrationHistoryPoint(
  date: string,
  dayRows: Array<Record<string, unknown>>,
): ConcentrationHistoryPoint {
  const stake = computeConcentration(dayRows.map((row) => row?.stake_tao));
  const emission = computeConcentration(
    dayRows.map((row) => row?.emission_tao),
  );
  return {
    snapshot_date: date,
    neuron_count: dayRows.length,
    stake_gini: stake?.gini ?? null,
    stake_nakamoto_coefficient: stake?.nakamoto_coefficient ?? null,
    stake_top_10pct_share: stake?.top_10pct_share ?? null,
    emission_gini: emission?.gini ?? null,
    emission_nakamoto_coefficient: emission?.nakamoto_coefficient ?? null,
    emission_top_10pct_share: emission?.top_10pct_share ?? null,
  };
}

export interface ConcentrationHistoryResult {
  schema_version: 1;
  netuid: number;
  window: string | null;
  point_count: number;
  points: ConcentrationHistoryPoint[];
}

// Build the per-day concentration time series (newest first) from neuron_daily
// rows already ordered snapshot_date DESC. `capped` (the read hit the row cap)
// drops the oldest day, which may be a partial distribution. Null-safe: a cold
// store yields point_count:0.
export function buildConcentrationHistory(
  rows: Array<Record<string, unknown>> | null | undefined,
  netuid: number,
  { window, capped }: { window?: string | null; capped?: boolean } = {},
): ConcentrationHistoryResult {
  const list = Array.isArray(rows) ? rows : [];
  // Group by snapshot_date. Rows arrive newest-first + same-date contiguous, so
  // Map insertion order is the newest-first date order we want.
  const byDate = new Map<string, Array<Record<string, unknown>>>();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)?.push(row);
  }
  let dates = [...byDate.keys()];
  if (capped && dates.length > 1) dates = dates.slice(0, -1);
  const points = dates.map((date) =>
    concentrationHistoryPoint(
      date,
      byDate.get(date) as Array<Record<string, unknown>>,
    ),
  );
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}

type D1Runner = (
  sql: string,
  params: unknown[],
) => Promise<Array<Record<string, unknown>>>;

// Shared D1 loaders for MCP tools — mirror handleSubnetConcentration and
// handleSubnetConcentrationHistory in workers/request-handlers/entities.ts.
export async function loadSubnetConcentration(
  d1: D1Runner,
  netuid: number,
): Promise<ConcentrationResult> {
  const rows = await d1(
    `SELECT ${CONCENTRATION_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  return buildConcentration(rows, netuid);
}

export async function loadSubnetConcentrationHistory(
  d1: D1Runner,
  netuid: number,
  { windowLabel, windowDays }: { windowLabel?: string; windowDays: number },
): Promise<ConcentrationHistoryResult> {
  const cutoff = new Date(Date.now() - windowDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await d1(
    "SELECT snapshot_date, stake_tao, emission_tao FROM neuron_daily WHERE netuid = ? AND snapshot_date >= ? ORDER BY snapshot_date DESC LIMIT ?",
    [netuid, cutoff, CONCENTRATION_HISTORY_ROW_CAP],
  );
  return buildConcentrationHistory(rows, netuid, {
    window: windowLabel,
    capped: rows.length >= CONCENTRATION_HISTORY_ROW_CAP,
  });
}
