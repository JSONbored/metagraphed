import { z } from "zod";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_MANTISSA = 10n ** 21n;
const unsigned = (max: bigint) =>
  z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(39)
    .pipe(z.string().refine((v) => BigInt(v) <= max));
const exponent = z
  .string()
  .regex(/^(0|-?[1-9]\d*)$/)
  .max(20)
  .pipe(z.string().refine((v) => BigInt(v) >= I64_MIN && BigInt(v) <= I64_MAX));
const safe = z.strictObject({ mantissa: unsigned(MAX_MANTISSA), exponent });
const original = z.strictObject({
  legacy_bits: unsigned(U128_MAX).nullable(),
  v2: safe.nullable(),
});

/** Authentic originals, not inferred pool sums. Null epochs preserve absence
 * and use the audited runtime's ValueQuery default zero. */
export const AlphaPoolEvidenceSchema = z.strictObject({
  share: original,
  denominator: original,
  total_alpha_rao: unsigned(U64_MAX),
  pool_epoch: unsigned(U64_MAX).nullable(),
  member_epoch: unsigned(U64_MAX).nullable(),
});
type Evidence = z.infer<typeof AlphaPoolEvidenceSchema>;
interface Decimal {
  mantissa: bigint;
  exponent: bigint;
}

// Mirrors the pinned share-pool SafeFloat normalization, bounded by its
//21-digit mantissa and signed64-bit exponent. BigInt intermediates are bounded
// below U256 here; no chain quantity is rounded through Number.
function normalize(mantissa: bigint, exp: bigint): Decimal | null {
  if (mantissa === 0n) return { mantissa: 0n, exponent: 0n };
  while (mantissa > MAX_MANTISSA) {
    mantissa /= 10n;
    exp++;
  }
  while (mantissa <= MAX_MANTISSA / 10n) {
    mantissa *= 10n;
    exp--;
  }
  return exp < I64_MIN || exp > I64_MAX ? null : { mantissa, exponent: exp };
}
const power = (exp: bigint) => 10n ** (exp > 22n ? 22n : exp);
function divide(a: Decimal, b: Decimal): Decimal | null {
  if (b.mantissa === 0n) return null;
  const exp = a.exponent - b.exponent - 21n;
  if (exp < I64_MIN || exp > I64_MAX) return null;
  return normalize((a.mantissa * MAX_MANTISSA) / b.mantissa, exp);
}
function add(a: Decimal, b: Decimal): Decimal | null {
  if (a.mantissa === 0n) return b;
  if (b.mantissa === 0n) return a;
  return a.exponent >= b.exponent
    ? normalize(
        a.mantissa + b.mantissa / power(a.exponent - b.exponent),
        a.exponent,
      )
    : normalize(
        a.mantissa / power(b.exponent - a.exponent) + b.mantissa,
        b.exponent,
      );
}
function legacy(bits: bigint): Decimal | null {
  if (bits === 0n) return { mantissa: 0n, exponent: 0n };
  const integer = normalize(bits >> 64n, 0n)!;
  const numerator = normalize(bits & U64_MAX, 0n)!;
  const denominator = normalize(1n << 64n, 0n)!;
  const fractional = divide(numerator, denominator);
  return fractional ? add(integer, fractional) : null;
}
function selected(value: Evidence["share"]): Decimal | null {
  // Legacy presence includes an explicit zero. It must win over V2 just as
  // try_get does; selecting the largest or first nonzero value changes truth.
  if (value.legacy_bits !== null) return legacy(BigInt(value.legacy_bits));
  return value.v2
    ? {
        mantissa: BigInt(value.v2.mantissa),
        exponent: BigInt(value.v2.exponent),
      }
    : { mantissa: 0n, exponent: 0n };
}
function integer(value: Decimal): bigint {
  const scaled =
    value.exponent >= 0n
      ? value.mantissa * power(value.exponent)
      : value.mantissa / power(-value.exponent);
  return scaled > U64_MAX ? U64_MAX : scaled;
}

/** Mirrors the selected runtime get_value: legacy-first originals and
 * SafeFloat mul_div/u64 saturation. Only478 applies retirement and pool cap.
 * The display fraction alone is a Number; exact originals/rao survive. */
export function quoteAlphaPool(value: unknown, specVersion: 454 | 478) {
  if (specVersion !== 454 && specVersion !== 478)
    throw new TypeError("Unsupported Alpha runtime semantics");
  const evidence = AlphaPoolEvidenceSchema.parse(value);
  const raw = selected(evidence.share),
    denominator = selected(evidence.denominator);
  const poolEpoch = BigInt(evidence.pool_epoch ?? "0"),
    memberEpoch = BigInt(evidence.member_epoch ?? "0");
  const retired =
    specVersion === 478 && poolEpoch !== 0n && poolEpoch !== memberEpoch;
  const share =
    retired && raw?.mantissa !== 0n ? { mantissa: 0n, exponent: 0n } : raw;
  const total = BigInt(evidence.total_alpha_rao),
    totalDecimal = normalize(total, 0n)!;
  let amount = 0n;
  let fraction = 0;
  if (share && denominator && denominator.mantissa > 0n) {
    const productExp = totalDecimal.exponent + share.exponent;
    const exp = productExp - denominator.exponent;
    const result =
      productExp < I64_MIN ||
      productExp > I64_MAX ||
      exp < I64_MIN ||
      exp > I64_MAX
        ? null
        : normalize(
            (totalDecimal.mantissa * share.mantissa) / denominator.mantissa,
            exp,
          );
    if (result) amount = integer(result);
    if (specVersion === 478 && amount > total) amount = total;
    const ratio = divide(share, denominator);
    if (ratio) fraction = Number(ratio.mantissa) * 10 ** Number(ratio.exponent);
    if (specVersion === 478) fraction = Math.min(1, fraction);
  }
  return {
    evidence,
    alphaRao: amount.toString(),
    shareFraction: Number.isFinite(fraction) ? fraction : null,
    retired,
    shareLayout:
      evidence.share.legacy_bits !== null ? "legacy-u64f64" : "safe-float",
  };
}
