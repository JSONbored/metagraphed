// A wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a
// registered neuron, each position's economics (stake, emission, rank, trust,
// incentive, dividends, role) and emission/stake yield, plus wallet-level
// aggregates — totals, subnet/validator counts, the overall return, and how
// concentrated the wallet's stake is across its subnets. Distinct from
// /accounts/{ss58}/subnets, which returns only the bare registration footprint
// (netuid/uid/stake/permit/active). Pure + exported for unit tests; the Worker
// does the D1 read + envelope. Null-safe: no positions -> schema-stable empty card.

import { computeConcentration } from "./concentration.mjs";

// The neurons-tier columns the portfolio reads for one hotkey.
export const ACCOUNT_PORTFOLIO_READ_COLUMNS =
  "netuid, uid, stake_tao, emission_tao, rank, trust, incentive, " +
  "dividends, validator_permit, active, captured_at";

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision.
const SCALE = 1e9;
function round9(value) {
  return Math.round(value * SCALE) / SCALE;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A nullable 0..1 score cell -> rounded number, or null when absent/non-finite.
function nullableScore(value) {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits
// string, so a blank/null/false cell is rejected rather than read as 0.
function toInt(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function captureStamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { ms: value, value: new Date(value).toISOString() };
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const ms = Number(value);
    return { ms, value: new Date(ms).toISOString() };
  }
  return null;
}

// Emission-per-stake return rate; null when stake is 0 (undefined return).
function computeYieldValue(emission, stake) {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

// Shape one hotkey's neuron rows into the cross-subnet portfolio. Null-safe on
// junk/sparse rows — an empty array yields a schema-stable empty card.
export function buildAccountPortfolio(rows, ss58) {
  const list = Array.isArray(rows) ? rows : [];
  const positions = [];
  const netuids = new Set();
  let validatorCount = 0;
  let totalStake = 0;
  let totalEmission = 0;
  let capturedAt = null;
  for (const row of list) {
    const netuid = toInt(row?.netuid);
    if (netuid == null) continue;
    netuids.add(netuid);
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const stake = toNumber(row?.stake_tao);
    const emission = toNumber(row?.emission_tao);
    const isValidator = Number(row?.validator_permit) === 1;
    if (isValidator) validatorCount += 1;
    totalStake += stake;
    totalEmission += emission;
    positions.push({
      netuid,
      uid: toInt(row?.uid),
      role: isValidator ? "validator" : "miner",
      active: Number(row?.active) === 1,
      stake_tao: round9(stake),
      emission_tao: round9(emission),
      rank: nullableScore(row?.rank),
      trust: nullableScore(row?.trust),
      incentive: nullableScore(row?.incentive),
      dividends: nullableScore(row?.dividends),
      yield: computeYieldValue(emission, stake),
    });
  }
  // Biggest position first; tie-break by netuid for a stable order.
  positions.sort((a, b) => b.stake_tao - a.stake_tao || a.netuid - b.netuid);
  return {
    schema_version: 1,
    ss58,
    captured_at: capturedAt?.value ?? null,
    subnet_count: netuids.size,
    position_count: positions.length,
    validator_count: validatorCount,
    miner_count: positions.length - validatorCount,
    total_stake_tao: round9(totalStake),
    total_emission_tao: round9(totalEmission),
    // Overall wallet return: total emission per total stake (null with no stake).
    overall_yield: totalStake > 0 ? round9(totalEmission / totalStake) : null,
    // How concentrated the wallet's stake is across its subnets (Gini/HHI/etc.).
    stake_concentration: computeConcentration(
      positions.map((p) => p.stake_tao),
    ),
    positions,
  };
}

// Shared D1 loader (REST + MCP parity): read every neuron registered under this
// hotkey and shape the portfolio. Cold/absent -> empty card. Mirrors
// loadAccountSubnets but reads the full economics columns.
export async function loadAccountPortfolio(d1, ss58) {
  const rows = await d1(
    `SELECT ${ACCOUNT_PORTFOLIO_READ_COLUMNS} FROM neurons WHERE hotkey = ? ORDER BY netuid`,
    [ss58],
  );
  return buildAccountPortfolio(rows, ss58);
}
