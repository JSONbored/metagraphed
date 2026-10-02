import { readNativeRuntime } from "./native-runtime.ts";
import type { StakeQuote, StakeQuoteFailure } from "./stake-quote.ts";

const WHOLE = 1_000_000_000n;
const MAX = (1n << 64n) - 1n;

/** Convert the caller's decimal number without silently rounding sub-RAO dust.
 * Exact atomic inputs remain available through the native runtime contract. */
export function stakeQuoteAtomic(amount: unknown): bigint | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
    return null;
  const [mantissa, exponent = "0"] = String(amount).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(whole! + fraction);
  const power = 9 + Number(exponent) - fraction.length;
  // Number's canonical string has no trailing fractional zeroes: a negative
  // shift therefore always represents sub-atomic dust, never a whole unit.
  if (power < 0) return null;
  const result = digits * 10n ** BigInt(power);
  return result > 0n && result <= MAX ? result : null;
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error("Invalid swap quantity");
  const result = BigInt(value);
  if (result > MAX) throw new Error("Swap quantity exceeds u64");
  return result;
}

function failure(status: number, code: string, error: string): StakeQuoteFailure {
  return { ok: false, status, code, error };
}

/** One metadata-backed source for price and simulation. No reserve-ratio
 * approximation, fallback estimate, transaction preparation or submission. */
export async function buildRuntimeStakeQuote(
  netuid: number,
  amount: unknown,
  direction: string,
  read: typeof readNativeRuntime = readNativeRuntime,
) {
  if (direction !== "stake" && direction !== "unstake")
    return failure(400, "invalid_direction", "`direction` must be stake or unstake.");
  const input = stakeQuoteAtomic(amount);
  if (input === null)
    return failure(400, "invalid_amount", "`amount` must be positive, representable in whole atomic units and within u64.");
  if (!Number.isInteger(netuid) || netuid < 0 || netuid > 65535)
    return failure(400, "invalid_netuid", "`netuid` must be an unsigned 16-bit subnet id.");
  const member = direction === "stake" ? "sim_swap_tao_for_alpha" : "sim_swap_alpha_for_tao";
  try {
    const artifact = await read({ operations: [
      { kind: "runtime", api: "SwapRuntimeApi", member: "current_alpha_price", args: [netuid] },
      { kind: "runtime", api: "SwapRuntimeApi", member, args: [netuid, input.toString()] },
    ] });
    const priceRow = artifact.results[0], swapRow = artifact.results[1];
    if (priceRow?.kind !== "runtime" || priceRow.api !== "SwapRuntimeApi" || priceRow.member !== "current_alpha_price" || swapRow?.kind !== "runtime" || swapRow.api !== "SwapRuntimeApi" || swapRow.member !== member)
      throw new Error("Swap contract mismatch");
    const price = quantity(priceRow.value);
    const value = swapRow.value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid swap result");
    const tao = quantity(value.tao_amount), alpha = quantity(value.alpha_amount);
    const taoFee = quantity(value.tao_fee), alphaFee = quantity(value.alpha_fee);
    quantity(value.tao_slippage);
    quantity(value.alpha_slippage);
    const output = direction === "stake" ? alpha : tao;
    const paid = direction === "stake" ? tao + taoFee : alpha + alphaFee;
    if (paid !== input || output === 0n || price === 0n)
      return failure(422, "insufficient_liquidity", "The finalized chain simulator could not fill this swap amount.");
    const spot = Number(price) / Number(WHOLE);
    const effective = direction === "stake" ? Number(input) / Number(alpha) : Number(tao) / Number(input);
    const quote: StakeQuote = {
      netuid, direction, amount: Number(input) / Number(WHOLE),
      expected_out: Number(output) / Number(WHOLE),
      expected_out_unit: direction === "stake" ? "alpha" : "tao",
      spot_price_tao: spot,
      effective_price_tao: effective,
      price_impact_pct: Math.abs(effective / spot - 1) * 100,
      // The simulator's price need not be the ratio of these legacy reserve
      // fields. Do not label unrelated snapshot reserves as this source.
      tao_in_pool_tao: null, alpha_in_pool: null, is_root: netuid === 0,
    };
    return { ok: true as const, quote, source: artifact.source };
  } catch {
    return failure(502, "stake_quote_failed", "The finalized chain simulation could not be completed.");
  }
}
