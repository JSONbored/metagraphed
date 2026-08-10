// Alpha priced in USD, and the reasons it sometimes cannot be (#10380).
//
// Every alpha economic figure we publish is denominated in TAO --
// `alpha_price_tao`, `alpha_market_cap_tao`, `alpha_fdv_tao`, `subnet_volume_tao`
// -- and we publish a TAO/USD index with better provenance than any third
// party (ADR 0025). Nothing composes them, so "what is this subnet's alpha
// worth in dollars" has no answer from us (#10379).
//
// ## The multiply is trivial; composing the two PROPERTIES is not
//
// PROVENANCE COMPOSES. `alpha_price_tao` is measured from the subnet AMM;
// `usd_per_tao` is a liquidity-weighted median across qualifying wTAO/WETH
// pools through an ETH/USDC anchor. Their product is RECONSTRUCTED, not
// measured, and `field_sources` has to say so -- the same distinction #10285
// draws for `comparison_price`, and for the same reason: labelling a
// derivation as a measurement attributes our arithmetic to the chain.
//
// AVAILABILITY COMPOSES, and this is the half that fails quietly. The index
// publishes `usd_per_tao: null` with `price_basis: "insufficient_pools"`
// whenever fewer than the quorum of pools qualify -- a STATED outcome, not a
// gap. A helper that multiplied whatever it last saw would serve a stale rate
// confidently and indefinitely, which is #9704 in a new place: a read with no
// live writer behind it, at 200 OK.
//
// So this returns a value with the block it came from, or a REASON. There is
// no third shape, and callers cannot get a number without its provenance.
//
// ## Why this is one module and not a helper per surface
//
// Six surfaces want USD (#10381, #10382, #10383). Six multiplications would be
// six chances to skip the staleness check, six places to fix a rounding rule,
// and six different words for the same unavailability. The point of a
// primitive is that the unhappy paths are written once.

import type { FiatPriceBasis } from "./tao-usd-index.ts";

/**
 * How old the TAO/USD reading may be before a price derived from it is refused.
 *
 * TWO HOURS, matching `tao_usd_index`'s own freshness bound in
 * src/table-freshness-watchdog.ts, which is sized against
 * `TAO_USD_INDEX_CRON` running every minute. Deliberately the SAME number
 * rather than a tighter one invented here: if a reading is fresh enough for the
 * watchdog to stay quiet, refusing to multiply by it would mean this module and
 * the watchdog disagree about whether the index is working, and an operator
 * would have two answers with no way to tell which to believe.
 *
 * It is generous against a one-minute cadence, which is the right direction --
 * the failure this guards is a rate frozen for hours, not one a few ticks old.
 */
export const TAO_USD_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Why a USD figure could not be produced. Every value is a stated outcome.
 *
 * A TUPLE, with the type derived from it, so the schemas can import the same
 * values rather than restating them -- a union declared here and re-typed in
 * two schema files is three places that can disagree about what we are willing
 * to say, and validate:schema-vocabularies exists to stop exactly that.
 *
 * - `no_index_reading` -- no TAO/USD reading at all; the index has never
 *   written, or the read found nothing.
 * - `index_unpriced` -- a reading exists and carries no price: ADR 0025's
 *   `insufficient_pools`. A published decline, never a price of zero.
 * - `index_stale` -- the newest reading is older than TAO_USD_MAX_AGE_MS.
 * - `no_alpha_price` -- the alpha side is missing. A subnet with no price is
 *   not one priced at 0.
 */
export const ALPHA_USD_UNAVAILABLE = [
  "no_index_reading",
  "index_unpriced",
  "index_stale",
  "no_alpha_price",
] as const;

export type AlphaUsdUnavailable = (typeof ALPHA_USD_UNAVAILABLE)[number];

/** The newest TAO/USD reading, in the shape `latest` already publishes. */
export interface TaoUsdReading {
  usd_per_tao: number | null;
  observed_at: string | null;
  block_number: number | null;
  price_basis: FiatPriceBasis | string | null;
}

/**
 * A USD figure with the provenance that produced it.
 *
 * The multiplier's block travels WITH the value rather than beside it in some
 * envelope, so a caller cannot serialise the number and drop the audit trail --
 * which is exactly what happened to `comparison_price` before #10285 published
 * `moving_price` next to it.
 */
export interface AlphaUsdValue {
  usd: number;
  usd_per_tao: number;
  tao_usd_block: number | null;
  tao_usd_observed_at: string | null;
  tao_usd_basis: FiatPriceBasis | string | null;
}

export type AlphaUsdResult =
  | { ok: true; value: AlphaUsdValue }
  | { ok: false; reason: AlphaUsdUnavailable };

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * Whether this reading may be multiplied by, and why not if it may not.
 *
 * Split from `alphaUsd` because every surface asks it once per response and
 * then prices many rows -- checking per row would be the same answer N times,
 * and a caller that forgot would be indistinguishable from one that asked.
 */
export function taoUsdUsable(
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
  maxAgeMs: number = TAO_USD_MAX_AGE_MS,
): { ok: true } | { ok: false; reason: AlphaUsdUnavailable } {
  if (!reading) return { ok: false, reason: "no_index_reading" };
  // `usd_per_tao: null` is `insufficient_pools`, which the CHECK constraint on
  // tao_usd_index guarantees is paired with that basis. It is a published
  // decline, not a missing field, and must never read as a price of zero.
  if (!finite(reading.usd_per_tao) || reading.usd_per_tao <= 0) {
    return { ok: false, reason: "index_unpriced" };
  }
  const observedMs = reading.observed_at
    ? Date.parse(reading.observed_at)
    : NaN;
  // An unparseable or absent stamp is treated as STALE rather than fresh. A
  // reading that cannot say when it was taken cannot be shown to be current,
  // and defaulting the unknown direction to "usable" is how a frozen rate
  // survives a staleness check.
  if (!Number.isFinite(observedMs)) return { ok: false, reason: "index_stale" };
  if (nowMs - observedMs > maxAgeMs)
    return { ok: false, reason: "index_stale" };
  return { ok: true };
}

/**
 * One alpha price in USD, or the reason there is none.
 *
 * `alphaTao` is a price, market cap, FDV or volume already denominated in TAO
 * -- the multiplication is identical for all of them, which is why this takes a
 * number rather than a named field.
 */
export function alphaUsd(
  alphaTao: number | null | undefined,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
  maxAgeMs: number = TAO_USD_MAX_AGE_MS,
): AlphaUsdResult {
  const usable = taoUsdUsable(reading, nowMs, maxAgeMs);
  if (!usable.ok) return { ok: false, reason: usable.reason };
  // Checked AFTER the index, so a caller with both problems is told about the
  // one that affects every row rather than the one affecting this row.
  //
  // ZERO IS A PRICE. `alpha_price_tao: 0` is a real reading -- a subnet whose
  // pool has no TAO in it -- and 0 x rate is a legitimate $0. Only null and
  // non-finite are refused, which is the same line src/subnet-deregistration-
  // ranking.ts draws for `moving_price`.
  if (!finite(alphaTao)) return { ok: false, reason: "no_alpha_price" };

  const rate = (reading as TaoUsdReading).usd_per_tao as number;
  return {
    ok: true,
    value: {
      // NOT rounded here. Rounding is a presentation decision and the right
      // number of places differs per field -- a per-alpha price needs eight,
      // a market cap needs none. Rounding at the source would silently cap the
      // precision every downstream surface could ever have.
      usd: alphaTao * rate,
      usd_per_tao: rate,
      tao_usd_block: (reading as TaoUsdReading).block_number ?? null,
      tao_usd_observed_at: (reading as TaoUsdReading).observed_at ?? null,
      tao_usd_basis: (reading as TaoUsdReading).price_basis ?? null,
    },
  };
}

/**
 * The `field_sources` entry every USD field must carry.
 *
 * RECONSTRUCTED, never measured. The product of two measurements is our
 * arithmetic, and `storage: null` says there is no single chain read behind it
 * -- the same shape DEREGISTRATION_FIELD_SOURCES uses for `comparison_price`.
 */
export const ALPHA_USD_FIELD_SOURCE = {
  kind: "reconstructed",
  storage: null,
} as const;
