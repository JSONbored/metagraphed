// A wallet's cross-subnet neuron portfolio: every subnet where the hotkey is a
// registered neuron, each position's economics (stake, emission, rank, trust,
// incentive, dividends, role) and emission/stake yield, plus wallet-level
// aggregates — totals, subnet/validator counts, the overall return, and how
// concentrated the wallet's stake is across its subnets. Distinct from
// /accounts/{ss58}/subnets, which returns only the bare registration footprint
// (netuid/uid/stake/permit/active). Pure + exported for unit tests; the Worker
// does the store read + envelope. Null-safe: no positions -> schema-stable empty card.

import { computeConcentration } from "./concentration.ts";
import { loadStoreAlphaPricesByNetuid } from "./metagraph-neurons.ts";
import { numberOrZero, round9 } from "./lib/rao.ts";
import { nonNegativeIntOrNull } from "./read-store.ts";

// The neurons-tier columns the portfolio reads for one hotkey.
export const ACCOUNT_PORTFOLIO_READ_COLUMNS =
  "netuid, uid, stake_tao, emission_tao, rank, trust, incentive, " +
  "dividends, validator_permit, active, captured_at";

// A nullable 0..1 score cell -> rounded number, or null when absent/non-finite.
function nullableScore(value: unknown): number | null {
  if (value == null) return null;
  // Blank cells coerce via Number("") → 0; trim rejects "" / whitespace-only.
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? round9(n) : null;
}

// Strict non-negative integer coercion: accept ONLY a real number or an all-digits
// string, so a blank/null/false cell is rejected rather than read as 0.

interface CaptureStamp {
  ms: number;
  value: string;
}

// Guard 0/negative epoch ms (a blank/sentinel cell) so captured_at never stamps
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
  stake_alpha: number;
  emission_alpha: number;
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
    // netuid -> alpha_price_tao (#9051). Root passes through at 1:1. A netuid
    // with no resolvable price keeps its position row (per-position
    // stake_alpha/emission_alpha/yield are single-subnet figures, untouched)
    // but is excluded from the cross-subnet totals. REQUIRED, never defaulted
    // -- see BuildGlobalValidatorsOptions for why.
    priceByNetuid,
  }: { priceByNetuid: Map<number, number | null> },
): AccountPortfolioResult {
  const list = Array.isArray(rows) ? rows : [];
  const positions: AccountPortfolioPosition[] = [];
  const pricedStakeByPosition: number[] = [];
  const netuids = new Set<number>();
  let validatorCount = 0;
  let totalStake = 0;
  let totalEmission = 0;
  let capturedAt: CaptureStamp | null = null;
  for (const row of list) {
    const netuid = nonNegativeIntOrNull(row?.netuid);
    if (netuid == null) continue;
    netuids.add(netuid);
    const captured = captureStamp(row?.captured_at);
    if (captured && (capturedAt == null || captured.ms > capturedAt.ms)) {
      capturedAt = captured;
    }
    const stake = numberOrZero(row?.stake_tao);
    const emission = numberOrZero(row?.emission_tao);
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
    if (price != null) {
      totalStake += stake * price;
      totalEmission += emission * price;
      pricedStakeByPosition.push(stake * price);
    }
    positions.push({
      netuid,
      uid: nonNegativeIntOrNull(row?.uid),
      role: isValidator ? "validator" : "miner",
      active: Number(row?.active) === 1,
      stake_alpha: round9(stake),
      emission_alpha: round9(emission),
      rank: nullableScore(row?.rank),
      trust: nullableScore(row?.trust),
      incentive: nullableScore(row?.incentive),
      dividends: nullableScore(row?.dividends),
      yield: computeYieldValue(emission, stake),
    });
  }
  // Biggest position first; tie-break by netuid for a stable order.
  positions.sort(
    (a, b) => b.stake_alpha - a.stake_alpha || a.netuid - b.netuid,
  );
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

// Shared store loader (REST + MCP parity): read every neuron registered under this
// hotkey and shape the portfolio. Cold/absent -> empty card. Like the former
// account-subnets registration D1 loader (removed in #4772) but reads the full
// economics columns.
export async function loadAccountPortfolio(
  runner: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  ss58: string,
): Promise<AccountPortfolioResult> {
  const [rows, priceByNetuid] = await Promise.all([
    runner(
      `SELECT ${ACCOUNT_PORTFOLIO_READ_COLUMNS} FROM neurons WHERE hotkey = ? ORDER BY netuid`,
      [ss58],
    ),
    // #9051: TAO-price the cross-subnet totals from the snapshot stores mirror.
    loadStoreAlphaPricesByNetuid(runner),
  ]);
  return buildAccountPortfolio(rows, ss58, { priceByNetuid });
}
