// #8600: decode Uniswap v3 pool state. Pure — no transport, no addresses.
//
// A v3 pool does not store a price. It stores `sqrtPriceX96`: the square root
// of the token1/token0 ratio, in Q64.96 fixed point. Recovering a price means
// squaring it, dividing by 2^192, and then correcting for the two tokens'
// decimal places, which are unrelated to each other (USDC has 6, WETH has 18,
// wTAO has 9).
//
// ALL OF THAT IS DONE IN BIGINT and converted to a float exactly once, at the
// end. sqrtPriceX96 is a uint160 — up to 110 significant bits in practice —
// and squaring it lands well past what a double can hold. Doing
// `(Number(sqrt) / 2 ** 96) ** 2` reads more naturally and silently discards
// the low bits of both the value and its square. The scaling here keeps 18
// decimal digits, which is more than the eventual USD figure can use.

/** Q64.96: prices are stored as sqrt(ratio) * 2^96. */
const Q192 = 1n << 192n;

/** Digits retained through the single integer division. */
const PRECISION = 10n ** 18n;

/** `eth_call` selectors. Keccak prefixes of the ABI signatures. */
export const UNISWAP_V3_SELECTORS = {
  /** `slot0()` — sqrtPriceX96 is its first return word. */
  slot0: "0x3850c7bd",
  /** `token0()` */
  token0: "0x0dfe1681",
  /** `token1()` */
  token1: "0xd21220a7",
} as const;

/** `balanceOf(address)` on the ERC-20s, for pool TVL. */
export const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

/**
 * `balanceOf(address)` calldata for `holder`.
 *
 * Addresses are left-padded to a full 32-byte word and lower-cased: an
 * EIP-55 checksummed address is a valid input everywhere else in this codebase
 * and would produce calldata a node reads as a different (zero) account.
 */
export function encodeBalanceOf(holder: string): string {
  const bare = holder.startsWith("0x") ? holder.slice(2) : holder;
  return ERC20_BALANCE_OF_SELECTOR + bare.toLowerCase().padStart(64, "0");
}

/**
 * The first 32-byte word of an `eth_call` result, as a bigint.
 *
 * Returns null rather than throwing for anything that is not a readable word —
 * a reverted call returns `0x`, and an unreachable node can return null
 * outright. Both mean "no reading", which the caller turns into an excluded
 * pool rather than a fabricated price.
 */
export function decodeFirstWord(result: unknown): bigint | null {
  if (typeof result !== "string") return null;
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (hex.length < 64) return null;
  const word = hex.slice(0, 64);
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null;
  return BigInt("0x" + word);
}

/** The address in the low 20 bytes of a returned word. Lower-cased. */
export function decodeAddress(result: unknown): string | null {
  const word = decodeFirstWord(result);
  if (word === null) return null;
  const hex = (word & ((1n << 160n) - 1n)).toString(16).padStart(40, "0");
  return "0x" + hex;
}

/**
 * Price of token0 denominated in token1, from `slot0`'s sqrtPriceX96.
 *
 * Returns null for a pool that has never been initialised (sqrtPriceX96 = 0)
 * or for decimals outside the ERC-20 range, rather than returning 0 or NaN —
 * a zero would pass a naive `> 0` check nowhere but would sail through a mean.
 */
export function priceToken1PerToken0(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number | null {
  if (sqrtPriceX96 <= 0n) return null;
  if (!Number.isInteger(decimals0) || decimals0 < 0 || decimals0 > 36)
    return null;
  if (!Number.isInteger(decimals1) || decimals1 < 0 || decimals1 > 36)
    return null;

  const numerator =
    sqrtPriceX96 * sqrtPriceX96 * 10n ** BigInt(decimals0) * PRECISION;
  const denominator = Q192 * 10n ** BigInt(decimals1);
  const scaled = numerator / denominator;
  const price = Number(scaled) / Number(PRECISION);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** A raw on-chain balance as a human-scaled float. Null if unreadable. */
export function scaleBalance(
  raw: bigint | null,
  decimals: number,
): number | null {
  if (raw === null || raw < 0n) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  // Divide in bigint down to PRECISION digits first, so a WETH balance (18
  // decimals, routinely 10^22 raw) does not lose its integer part to a float.
  const scaled = (raw * PRECISION) / 10n ** BigInt(decimals);
  const value = Number(scaled) / Number(PRECISION);
  return Number.isFinite(value) ? value : null;
}
