// A wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a
// registered neuron, each position's economics (stake, emission, rank, trust,
// incentive, dividends, role) and emission/stake yield, plus wallet-level
// aggregates — totals, subnet/validator counts, the overall return, and how
// concentrated the wallet's stake is across its subnets. Distinct from
// /accounts/{ss58}/subnets, which returns only the bare registration footprint
// (netuid/uid/stake/permit/active). Pure + exported for unit tests; the Worker
// does the D1 read + envelope. Null-safe: no positions -> schema-stable empty card.

import { computeConcentration } from "./concentration.ts";
import { loadD1AlphaPricesByNetuid } from "./metagraph-neurons.ts";

// The neurons-tier columns the portfolio reads for one hotkey.
export const ACCOUNT_PORTFOLIO_READ_COLUMNS =
  "netuid, uid, stake_tao, emission_tao, rank, trust, incentive, " +
  "dividends, validator_permit, active, captured_at";

// 1 TAO = 1e9 rao; round tao + yield outputs to that precision.
const SCALE = 1e9;
function round9(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}

// Coerce a D1 numeric cell (number, numeric string, or null) to a finite number.
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// A nullable 0..1 score cell -> rounded number, or null when absent/non-finite.
function nullableScore(value: unknown): number | null {
  if (value == null) return null;
  // Blank D1 cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits
// string, so a blank/null/false cell is rejected rather than read as 0.
function toInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

interface CaptureStamp {
  ms: number;
  value: string;
}

// Guard 0/negative epoch ms (a blank/sentinel D1 cell) so captured_at never stamps
// the 1970 epoch; mirrors epochMsStamp in concentration.ts / subnet-performance.ts.
function captureStamp(value: unknown): CaptureStamp | null {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    ms = Number(value);
  } else {
    return null;
  }
  if (ms <= 0) return null;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return null;
  return { ms, value: date.toISOString() };
}

// Emission-per-stake return rate; null when stake is 0 (undefined return).
function computeYieldValue(emission: number, stake: number): number | null {
  if (!(stake > 0)) return null;
  return round9(emission / stake);
}

export interface AccountPortfolioPosition {
  netuid: number;
  uid: number | null;
  role: "validator" | "miner";
  active: boolean;
  stake_tao: number;
  emission_tao: number;
  rank: number | null;
  trust: number | null;
  incentive: number | null;
  dividends: number | null;
  yield: number | null;
}

export interface AccountPortfolioResult {
  schema_version: 1;
  ss58: string;
  captured_at: string | null;
  subnet_count: number;
  position_count: number;
  validator_count: number;
  miner_count: number;
  total_stake_tao: number;
  total_emission_tao: number;
  unpriced_stake_alpha: number;
  unpriced_emission_alpha: number;
  overall_yield: number | null;
  stake_concentration: unknown;
  positions: AccountPortfolioPosition[];
}

// Shape one hotkey's neuron rows into the cross-subnet portfolio. Null-safe on
// junk/sparse rows — an empty array yields a schema-stable empty card.
export function buildAccountPortfolio(
  rows: Array<Record<string, unknown>> | null | undefined,
  ss58: string,
  {
    // netuid -> alpha_price_tao (#9051). Root passes through at 1:1; a
    // netuid with no resolvable price keeps its position row (per-position
    // stake_tao/emission_tao/yield are single-subnet figures, untouched)
    // but contributes to the unpriced_* residuals instead of the totals,
    // overall_yield, and stake_concentration.
    priceByNetuid = new Map<number, number | null>(),
  }: { priceByNetuid?: Map<number, number | null> } = {},
): AccountPortfolioResult {
  const list = Array.isArray(rows) ? rows : [];
  const positions: AccountPortfolioPosition[] = [];
  const pricedStakeByPosition: number[] = [];
  const netuids = new Set<number>();
  let validatorCount = 0;
  let totalStake = 0;
  let totalEmission = 0;
  let unpricedStake = 0;
  let unpricedEmission = 0;
  let capturedAt: CaptureStamp | null = null;
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
    const rowPrice = priceByNetuid.get(netuid);
    const price =
      netuid === 0
        ? 1
        : typeof rowPrice === "number" &&
            Number.isFinite(rowPrice) &&
            rowPrice >= 0
          ? rowPrice
          : null;
    if (price == null) {
      unpricedStake += stake;
      unpricedEmission += emission;
    } else {
      totalStake += stake * price;
      totalEmission += emission * price;
      pricedStakeByPosition.push(stake * price);
    }
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
    // The alpha the priced totals do NOT cover (#9051) -- positions on
    // subnets with no resolvable alpha price.
    unpriced_stake_alpha: round9(unpricedStake),
    unpriced_emission_alpha: round9(unpricedEmission),
    // Overall wallet return: priced emission per priced stake -- both sides
    // in TAO, so the ratio is dimensionally coherent for the first time
    // (#9051). Null with no priceable stake.
    overall_yield: totalStake > 0 ? round9(totalEmission / totalStake) : null,
    // How concentrated the wallet's VALUE is across its priceable positions
    // (Gini/HHI/etc.) -- priced legs only, since mixing different alpha
    // units would weight the concentration by token count, not value.
    stake_concentration: computeConcentration(pricedStakeByPosition),
    positions,
  };
}

// Shared D1 loader (REST + MCP parity): read every neuron registered under this
// hotkey and shape the portfolio. Cold/absent -> empty card. Like the former
// account-subnets registration D1 loader (removed in #4772) but reads the full
// economics columns.
export async function loadAccountPortfolio(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  ss58: string,
): Promise<AccountPortfolioResult> {
  const [rows, priceByNetuid] = await Promise.all([
    d1(
      `SELECT ${ACCOUNT_PORTFOLIO_READ_COLUMNS} FROM neurons WHERE hotkey = ? ORDER BY netuid`,
      [ss58],
    ),
    // #9051: TAO-price the cross-subnet totals from the D1 snapshots mirror.
    loadD1AlphaPricesByNetuid(d1),
  ]);
  return buildAccountPortfolio(rows, ss58, { priceByNetuid });
}
