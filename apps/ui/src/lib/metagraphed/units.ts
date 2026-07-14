// RAO / TAO / alpha unit conversion (native-staking epic #5229, #5237).
//
// Every on-chain stake amount is a u64 rao/alpha integer -- TaoBalance/
// AlphaBalance in the subtensor pallet (verified against
// pallets/subtensor/src/common/currency.rs, live 2026-07-14: both are
// `#[repr(transparent)] struct(u64)`, CompactAs-encoded) -- never a float.
// BigInt throughout: rao amounts routinely exceed Number.MAX_SAFE_INTEGER
// (2^53) for large holdings, and float arithmetic on chain amounts is exactly
// the class of bug this epic exists to avoid.
//
// TAO and alpha are BOTH 1e9-scaled (1 TAO = 1e9 rao; 1 alpha = 1e9 raw alpha
// units -- the pallet's AlphaBalance mirrors TaoBalance's u64 shape exactly),
// but they are NEVER directly comparable without a price (alpha is
// subnet-scoped; TAO is not) -- ADR 0018 §1. Branded types make that a
// compile-time distinction, not just a naming convention: a Rao value cannot
// be passed where a RawAlpha is expected, or vice versa, without an explicit
// (and grep-able) cast.

export const UNITS_PER_WHOLE = 1_000_000_000n;

declare const RaoBrand: unique symbol;
declare const RawAlphaBrand: unique symbol;

/** Whole rao (the on-chain unit for TaoBalance) -- 1 TAO = 1e9 rao. */
export type Rao = bigint & { readonly [RaoBrand]: true };
/** Whole raw alpha units (the on-chain unit for AlphaBalance) -- 1 alpha = 1e9 raw units. */
export type RawAlpha = bigint & { readonly [RawAlphaBrand]: true };

function parseWholeUnitDecimal(value: string | number, label: string): bigint {
  const str = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid ${label} amount: "${value}"`);
  }
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [whole, frac = ""] = unsigned.split(".");
  if (frac.length > 9) {
    throw new Error(
      `Sub-unit precision: "${value}" has more than 9 fractional digits, finer than a single rao/raw-alpha unit can represent`,
    );
  }
  const paddedFrac = frac.padEnd(9, "0");
  const units = BigInt(whole || "0") * UNITS_PER_WHOLE + BigInt(paddedFrac || "0");
  return negative ? -units : units;
}

function formatWholeUnitDecimal(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / UNITS_PER_WHOLE;
  const frac = abs % UNITS_PER_WHOLE;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracStr ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`;
}

/** Parse a decimal TAO amount (string or number) into whole rao. */
export function taoToRao(tao: string | number): Rao {
  return parseWholeUnitDecimal(tao, "TAO") as Rao;
}

/** Format whole rao as a decimal TAO string, trimming trailing zeros. */
export function raoToTao(rao: Rao): string {
  return formatWholeUnitDecimal(rao);
}

/** Parse a decimal alpha amount (string or number) into whole raw alpha units. */
export function alphaToRawAlpha(alpha: string | number): RawAlpha {
  return parseWholeUnitDecimal(alpha, "alpha") as RawAlpha;
}

/** Format whole raw alpha units as a decimal alpha string, trimming trailing zeros. */
export function rawAlphaToAlpha(rawAlpha: RawAlpha): string {
  return formatWholeUnitDecimal(rawAlpha);
}

/** Construct a Rao value from an already-whole-unit bigint (e.g. read from chain state). */
export function asRao(units: bigint): Rao {
  return units as Rao;
}

/** Construct a RawAlpha value from an already-whole-unit bigint (e.g. read from chain state). */
export function asRawAlpha(units: bigint): RawAlpha {
  return units as RawAlpha;
}
