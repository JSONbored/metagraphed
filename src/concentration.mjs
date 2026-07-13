// Subnet concentration / decentralization metrics (#2106): pure statistics over a
// subnet's per-UID value distribution (stake_tao, emission_tao from the live
// `neurons` D1 tier). Every function is pure + exported for unit tests; the Worker
// does the D1 read + envelope. Null-safe by design: an empty / all-zero
// distribution yields a schema-stable `null` block (never throws), matching the
// live metagraph tiers the entity handlers already own.

import { DAY_MS } from "../workers/config.mjs";

// The neurons-tier columns the concentration handler reads — the D1 read contract
// for buildConcentration (mirrors BLOCK_READ_COLUMNS / EXTRINSIC_READ_COLUMNS). Kept
// here next to its consumer so the Worker handler stays a thin SELECT.
export const CONCENTRATION_READ_COLUMNS =
  "stake_tao, emission_tao, coldkey, validator_permit, captured_at";

// Top-K%-of-holders cutoffs reported as cumulative shares of the total.
const TOP_PERCENTILES = [1, 5, 10, 20];

// Round a ratio/amount to a stable decimal precision; null/non-finite → null so the
// schema stays `number|null` and JSON never carries a long floating-point tail.
function round(value, dp = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

// Round a 0..1 concentration ratio (gini, hhi, normalized variants, top-K share)
// WITHOUT letting a sub-perfect value round up to an exact 1 — a near-monopoly
// that holds 99.99996% must not display as a perfect 1.0 ("total concentration"),
// the same anti-overstatement guard the turnover/chain-activity ratios apply. A
// genuine ratio of exactly 1 (e.g. a single holder's 100% share) keeps 1.0.
function roundRatio(value, dp = 6) {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// Sum in rao-integer BigInt space, not float space -- summing potentially
// thousands of network-wide stake_tao/emission_tao floats (per controlling
// entity, or as a distribution total) with plain `+=` compounds rounding error
// across the accumulation even when each individual value is itself exact
// (metagraphed#2922, mirrors the toRaoBig pattern in src/chain-yield.mjs and
// src/metagraph-neurons.mjs). Convert back to TAO only once, at the very end.
function toRaoBig(taoValue) {
  const n = typeof taoValue === "number" ? taoValue : Number(taoValue);
  return Number.isFinite(n) ? BigInt(Math.round(n * 1e9)) : 0n;
}
function raoBigToTao(rao) {
  return Number(rao / 1_000_000_000n) + Number(rao % 1_000_000_000n) / 1e9;
}

function epochMsStamp(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

function captureStamp(value) {
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
function positiveValues(values) {
  const out = [];
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
function gini(ascending, total) {
  const n = ascending.length;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * ascending[i];
  const g = (2 * weighted) / (n * total) - (n + 1) / n;
  return g < 0 ? 0 : g;
}

// Herfindahl–Hirschman Index: Σ shareᵢ². Ranges [1/n, 1]; 1 = monopoly.
function hhi(values, total) {
  let sum = 0;
  for (const v of values) {
    const share = v / total;
    sum += share * share;
  }
  return sum;
}

// Normalize HHI to [0,1] independent of holder count: (H − 1/n)/(1 − 1/n). A single
// holder (n = 1) is defined as 1 (maximally concentrated).
function hhiNormalized(h, n) {
  if (n <= 1) return 1;
  return (h - 1 / n) / (1 - 1 / n);
}

// Nakamoto coefficient: the fewest top holders whose cumulative share strictly
// exceeds 50% — the smallest set that could collude to control the subnet.
function nakamoto(descending, total) {
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

// Cumulative share held by the top ⌈n·p/100⌉ holders for each p in TOP_PERCENTILES
// (at least one holder). One prefix-sum pass, then each cutoff is an O(1) read.
function topShares(descending, total) {
  const n = descending.length;
  const prefix = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += descending[i];
    prefix[i] = acc;
  }
  const out = {};
  for (const p of TOP_PERCENTILES) {
    const k = Math.max(1, Math.ceil((n * p) / 100));
    out[`top_${p}pct_share`] = roundRatio(prefix[k - 1] / total);
  }
  return out;
}

// Shannon entropy of the share distribution (bits) + its normalization against the
// log2(n) maximum: 1 = perfectly uniform, →0 = fully concentrated.
function entropy(values, total) {
  let bits = 0;
  for (const v of values) {
    const share = v / total;
    if (share > 0) bits -= share * Math.log2(share);
  }
  const normalized = values.length > 1 ? bits / Math.log2(values.length) : 0;
  return { bits, normalized };
}

// Full concentration scorecard for one value column, or `null` when there is no
// positive distribution to measure (cold store / empty subnet / all-zero column).
export function computeConcentration(values) {
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
function groupByEntity(rows) {
  const stakeRao = new Map();
  const emissionRao = new Map();
  for (const row of rows) {
    const hasColdkey =
      typeof row?.coldkey === "string" && row.coldkey.length > 0;
    const key = hasColdkey ? row.coldkey : {};
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
export function buildConcentration(rows, netuid) {
  const list = Array.isArray(rows) ? rows : [];
  // The rows share one cron capture, but don't assume an order — take the newest.
  let capturedAt = null;
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
export function buildChainConcentration(rows) {
  const list = Array.isArray(rows) ? rows : [];
  // One cron capture underlies the rows, but don't assume order — take the newest.
  let capturedAt = null;
  const netuids = new Set();
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
export async function loadChainConcentration(d1) {
  const rows = await d1(
    `SELECT ${CHAIN_CONCENTRATION_READ_COLUMNS} FROM neurons`,
    [],
  );
  return buildChainConcentration(rows);
}

// ---- Concentration HISTORY (decentralization over time) --------------------
// Per-day concentration from the dated neuron_daily rollup, so a subnet's
// centralization trend (is power consolidating?) is chartable. Windows are
// bounded to a chartable range because each day needs its full per-UID
// distribution (concentration can't be a cheap SQL GROUP BY like the structural
// history) — a row cap then guards an unexpectedly large subnet.
export const CONCENTRATION_HISTORY_WINDOWS = { "7d": 7, "30d": 30, "90d": 90 };
export const DEFAULT_CONCENTRATION_HISTORY_WINDOW = "30d";
// Safety valve on the raw per-UID read (≈256 UIDs × 90d ≈ 23k; this leaves head
// room and the builder drops a truncated oldest day so every point is complete).
export const CONCENTRATION_HISTORY_ROW_CAP = 50_000;

// Parse ?window for the history route — a deliberately smaller set than the
// structural history (no 1y/all) so the raw read stays bounded. Returns
// {label, days} or {error:{parameter,message}} (the analyticsQueryError shape).
export function parseConcentrationHistoryWindow(value) {
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

// Project one day's per-UID rows to a flat, chartable concentration point. Flat
// (not nested) fields keep a time series trivial to plot. Null-safe — a cold/empty
// day yields null metrics, never throws.
function concentrationHistoryPoint(date, dayRows) {
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

// Build the per-day concentration time series (newest first) from neuron_daily
// rows already ordered snapshot_date DESC. `capped` (the read hit the row cap)
// drops the oldest day, which may be a partial distribution. Null-safe: a cold
// store yields point_count:0.
export function buildConcentrationHistory(
  rows,
  netuid,
  { window, capped } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  // Group by snapshot_date. Rows arrive newest-first + same-date contiguous, so
  // Map insertion order is the newest-first date order we want.
  const byDate = new Map();
  for (const row of list) {
    const date = row?.snapshot_date;
    if (typeof date !== "string" || !date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(row);
  }
  let dates = [...byDate.keys()];
  if (capped && dates.length > 1) dates = dates.slice(0, -1);
  const points = dates.map((date) =>
    concentrationHistoryPoint(date, byDate.get(date)),
  );
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    point_count: points.length,
    points,
  };
}

// Shared D1 loaders for MCP tools — mirror handleSubnetConcentration and
// handleSubnetConcentrationHistory in workers/request-handlers/entities.mjs.
export async function loadSubnetConcentration(d1, netuid) {
  const rows = await d1(
    `SELECT ${CONCENTRATION_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  return buildConcentration(rows, netuid);
}

export async function loadSubnetConcentrationHistory(
  d1,
  netuid,
  { windowLabel, windowDays },
) {
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
