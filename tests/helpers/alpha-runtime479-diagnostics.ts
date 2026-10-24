import {
  alphaPoolMulDiv,
  divide,
  integer,
  quoteAlphaPool,
  selected,
  type Decimal,
  type Evidence,
} from "../../src/alpha-share-value.ts";

const source = (value: Evidence["share"]) =>
  value.legacy_bits !== null ? "legacy" : value.v2 ? "v2" : "absent";
const decimal = (value: Decimal | null) =>
  value === null
    ? null
    : {
        mantissa: value.mantissa.toString(),
        exponent: value.exponent.toString(),
      };

/** Test-only diagnostics use the receiver's actual conversion, checked
 * arithmetic and getter result; they are absent from the Worker import graph. */
export function runtime479Diagnostics(value: unknown) {
  const quote = quoteAlphaPool(value, 479);
  const evidence = quote.evidence;
  const shareSource = source(evidence.share),
    denominatorSource = source(evidence.denominator);
  const raw = shareSource === "absent" ? null : selected(evidence.share),
    denominator = selected(evidence.denominator)!;
  const status =
    raw === null ? "missing_member" : quote.retired ? "retired_member" : "ok";
  const share = status === "ok" ? raw : null;
  const total = BigInt(evidence.total_alpha_rao);
  const result =
    share && denominator.mantissa > 0n
      ? alphaPoolMulDiv(total, share, denominator)
      : null;
  const uncapped = result === null ? null : integer(result);
  const ratio =
    share && denominator.mantissa > 0n ? divide(share, denominator) : null;
  const classification =
    status !== "ok"
      ? status
      : share!.mantissa === 0n
        ? "zero_share"
        : denominator.mantissa === 0n
          ? "zero_denominator"
          : total === 0n
            ? "zero_pool_value"
            : uncapped === null
              ? "arithmetic_failure_zero"
              : uncapped > total
                ? "capped_at_pool_value"
                : "valued";
  return {
    status,
    classification,
    shareSource,
    denominatorSource,
    rawShare: decimal(raw),
    effectiveShare: decimal(share),
    effectiveDenominator: decimal(denominator),
    poolEpoch: evidence.pool_epoch ?? "0",
    memberEpoch: evidence.member_epoch ?? "0",
    divisionRatio: decimal(ratio),
    uncappedAlphaRao: uncapped?.toString() ?? null,
    tryGetValueAlphaRao: quote.tryGetValueAlphaRao,
    runtimeGetterAlphaRao: quote.alphaRao,
  };
}
