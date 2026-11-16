// The subnet-swap serving builders (#13165) -- shared by the REST handler,
// the GraphQL resolver and the MCP tool, so the three surfaces cannot drift.
// Pure + exported for tests; callers resolve the store (the native seam in
// subnet-swap-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The balancer state's writers -- the
// engine's Swap.BalancerTaoReservoir / Swap.BalancerAlphaReservoir /
// Swap.FeeRate decode -- land separately (#13165 defers them), so an absent
// capture is not "this subnet's pool is empty": it is "the balancer capture
// has not run", and `swap: null` is how the artifact says so. Reservoirs are
// u64 atomic units as decimal strings; fee_rate is the chain's raw u16 as
// stored, because the engine's decode owns any scaling.
import { selectedSubnetSwapStore } from "./subnet-swap-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The chain's raw u16 fee rate, or null -- never coalesced to 0, which
 * would claim a measured fee-free pool. */
export function feeRateOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65535
    ? parsed
    : null;
}

/** One stored capture row to the published per-subnet balancer state. */
export function formatSwapState(row: Row): Row {
  return {
    tao_reservoir: u64TextOrNull(row?.tao_reservoir),
    alpha_reservoir: u64TextOrNull(row?.alpha_reservoir),
    fee_rate: feeRateOrNull(row?.fee_rate),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetSwap(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const row = rows?.[0];
  const swap = row === undefined ? null : formatSwapState(row);
  return {
    schema_version: 1,
    netuid,
    swap,
    captured_at: swap === null ? null : (swap.captured_at as string | null),
  };
}

/**
 * One subnet's newest balancer capture through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetSwap(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetSwapStore(env);
  if (!store) return null;
  try {
    return await store.latest(netuid);
  } catch (error) {
    console.error("subnet swap store read failed:", error);
    return null;
  }
}
