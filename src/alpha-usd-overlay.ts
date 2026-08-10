// USD on the economics rows, applied where the tiers converge (#10381).
//
// Same shape as `withSpotPrice`/`withSpotPricedEconomics` in
// src/health-serving.ts, and for the same reason: /api/v1/economics serves from
// the live KV blob OR the R2 artifact, so a decoration applied at the seam
// where they converge reaches both without either producer changing. Doing it
// in the builder would decorate one tier and silently skip the other.
//
// ## Asked ONCE per response, not once per row
//
// `taoUsdUsable` is checked for the blob and the answer reused across all 129
// subnets. Per-row checks would recompute one identical verdict 129 times, and
// a row that forgot to ask would be indistinguishable from one that asked and
// got a price -- both would just have a number.
//
// ## The instant these figures describe
//
// The alpha prices come from the economics capture; the rate comes from the
// newest TAO/USD reading. Those are DIFFERENT MOMENTS, bounded by #10380's
// staleness rule rather than pinned to each other. That is acceptable for a
// spot figure and it is why every row carries `tao_usd_block` -- a reader can
// see which instant the multiplier came from instead of assuming it matches
// `block`. It stops being acceptable at series scale, which is what #10382's
// per-bucket join exists to handle.

import {
  ALPHA_USD_FIELD_SOURCE,
  alphaUsd,
  taoUsdUsable,
  type AlphaUsdUnavailable,
  type TaoUsdReading,
} from "./alpha-usd.ts";

type Row = Record<string, unknown>;

/**
 * What `alpha_market_cap_tao` multiplies, published rather than documented.
 *
 * `computeAlphaMarketCapTao` (scripts/lib/economics-artifacts.ts) is
 * `alpha_price_tao x total_stake_alpha`, and the methodology doc says
 * `total_stake_alpha` "stands in as the circulating-alpha proxy until a
 * dedicated supply field exists".
 *
 * THAT ANSWER EXISTED IN THREE PLACES AND NOT IN THE PAYLOAD -- a doc, the
 * route description, and a `hint="proxy"` in the UI. A consumer reading JSON
 * could not discover the denominator, which is exactly the gap #10300 had to
 * close for TAO: coinpaprika reported a market cap on ~9.61M circulating
 * against the chain's 11.22M issuance, ~17% apart, and NEITHER WAS WRONG --
 * they were different denominators. A market cap without its basis is not a
 * number anyone can reconcile.
 */
export const ALPHA_MARKET_CAP_BASIS = "total_stake_alpha" as const;

/** The `_usd` twin of a `_tao` field, and where its multiplier came from. */
const USD_FIELDS = [
  ["alpha_price_tao", "alpha_price_usd"],
  ["alpha_market_cap_tao", "alpha_market_cap_usd"],
  ["alpha_fdv_tao", "alpha_fdv_usd"],
] as const;

export interface AlphaUsdOverlay {
  /** Absent when the index could not be used; the reason says why. */
  tao_usd?: {
    usd_per_tao: number;
    block_number: number | null;
    observed_at: string | null;
    price_basis: string | null;
  };
  tao_usd_unavailable?: AlphaUsdUnavailable;
}

/**
 * Decorate one economics row with its USD twins.
 *
 * A `_usd` field is EMITTED ONLY when it has a value. An explicit
 * `alpha_price_usd: null` would be indistinguishable from a genuine zero once
 * it reached a chart, and the blob-level `tao_usd_unavailable` already says why
 * every row is missing them -- so absence is the honest encoding, the same
 * choice buildTaoUsdSeries makes for `points` when a caller opts out.
 */
export function withAlphaUsd(
  row: Row | null | undefined,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): Row | null | undefined {
  if (!row || typeof row !== "object") return row;
  const out: Row = { ...row };
  // Published even when USD is unavailable: the denominator is a property of
  // alpha_market_cap_tao, which is present either way.
  if (row.alpha_market_cap_tao !== undefined) {
    out.alpha_market_cap_basis = ALPHA_MARKET_CAP_BASIS;
  }
  for (const [taoField, usdField] of USD_FIELDS) {
    const priced = alphaUsd(row[taoField] as number | null, reading, nowMs);
    if (priced.ok) out[usdField] = priced.value.usd;
  }
  return out;
}

/**
 * Decorate a whole economics blob.
 *
 * The provenance rides at the BLOB level rather than on every row: one reading
 * priced all of them, so repeating its block 129 times would be 129 copies of
 * one fact -- the same reasoning that keeps `pools` on
 * /api/v1/network/tao-usd's `latest` instead of on all 2,000 points.
 */
export function withAlphaUsdEconomics(
  blob: Row | null | undefined,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): Row | null | undefined {
  if (!blob || typeof blob !== "object") return blob;
  const rows = blob.subnets;
  if (!Array.isArray(rows)) return blob;

  const usable = taoUsdUsable(reading, nowMs);
  const overlay: AlphaUsdOverlay = usable.ok
    ? {
        tao_usd: {
          usd_per_tao: (reading as TaoUsdReading).usd_per_tao as number,
          block_number: (reading as TaoUsdReading).block_number ?? null,
          observed_at: (reading as TaoUsdReading).observed_at ?? null,
          price_basis: (reading as TaoUsdReading).price_basis ?? null,
        },
      }
    : // NAMED, not merely absent. "No USD fields" and "no USD fields BECAUSE the
      // index has too few pools" are different answers, and only the second one
      // tells a caller whether to retry or to stop asking.
      { tao_usd_unavailable: usable.reason };

  return {
    ...blob,
    ...overlay,
    subnets: (rows as Row[]).map((row) =>
      usable.ok ? withAlphaUsd(row, reading, nowMs) : row,
    ),
    field_sources: {
      ...(typeof blob.field_sources === "object" && blob.field_sources
        ? (blob.field_sources as Row)
        : {}),
      alpha_price_usd: ALPHA_USD_FIELD_SOURCE,
      alpha_market_cap_usd: ALPHA_USD_FIELD_SOURCE,
      alpha_fdv_usd: ALPHA_USD_FIELD_SOURCE,
    },
  };
}

// --- Volume (#10383) -------------------------------------------------------
//
// A 24h volume total is an AGGREGATE, which makes the multiplier question
// sharper than for a spot price: multiplying a window's total by one rate is
// not the same as summing each trade at the rate it executed at.
//
// It is priced at ONE rate here, and says so. Two facts decide it:
//
//   1. The window is FIXED at 24h on both routes (src/alpha-volume.ts,
//      src/chain-alpha-volume.ts -- "a canonical market-depth figure, not a
//      windowed analytics view", #4339). The 30d case where per-trade and
//      single-rate diverge materially cannot be requested.
//   2. The totals arrive ALREADY SUMMED. handleSubnetVolume receives
//      `ReturnType<typeof buildAlphaVolume>` from the Postgres tier, so no
//      per-trade instant survives to the edge; pricing each trade would mean
//      pushing the multiply into both producers for a difference bounded by one
//      day of rate movement.
//
// So this is NOT the per-bucket rule src/alpha-usd-history.ts applies to a
// SERIES, and that is deliberate: a series has one instant per point, while a
// single aggregate over a fixed window has one instant. Applying the per-bucket
// machinery here would be a more complicated way of saying the same thing.
//
// The basis is NAMED in the payload rather than left to be assumed, because
// "$4.1M of volume" reads identically whether it was summed per trade or
// converted at the close, and only one of those is what we did.

/**
 * How a volume total was converted: the rate at the window's close.
 *
 * A string rather than a boolean, so a future per-trade implementation can
 * publish a different value instead of silently changing what the same shape
 * means.
 */
export const VOLUME_USD_PRICING_BASIS = "window_close_rate" as const;

/** TAO-denominated volume fields and their USD twins. */
const VOLUME_USD_FIELDS = [
  ["buy_volume_tao", "buy_volume_usd"],
  ["sell_volume_tao", "sell_volume_usd"],
  ["total_volume_tao", "total_volume_usd"],
] as const;

// DELIBERATELY ABSENT: buy/sell/total/net_volume_ALPHA, sentiment and
// sentiment_ratio.
//
// The alpha totals are denominated in alpha, and the only alpha price this
// payload could yield is total_volume_tao / total_volume_alpha -- the window's
// own realised VWAP. Multiplying the alpha volume by it returns
// total_volume_tao exactly, so an `*_alpha_usd` field would be a second name
// for a number already published. `sentiment_ratio` is a ratio of two alpha
// figures and `sentiment` is a label: both are DIMENSIONLESS, and a
// dimensionless quantity has no currency to be expressed in.

// volume_distribution is DELIBERATELY NOT PRICED. Its percentiles are TAO and
// would convert perfectly well, but the shape is `IntensityDistribution` -- a
// REGISTERED OpenAPI component shared with /chain/network-rollups. Adding
// `_usd` fields to it would declare USD on a route that does not publish it,
// and forking the component for one caller trades a shared type for a
// duplicate. A caller wanting the spread in dollars has `tao_usd.usd_per_tao`
// published right beside it and can multiply; that is a better trade than a
// second distribution type.

/** Add `_usd` twins for a set of TAO fields. Absent when unpriceable. */
function priceTaoFields(
  row: Row,
  pairs: ReadonlyArray<readonly [string, string]>,
  reading: TaoUsdReading,
  nowMs: number,
): Row {
  const out: Row = { ...row };
  for (const [taoField, usdField] of pairs) {
    const priced = alphaUsd(row[taoField] as number | null, reading, nowMs);
    if (priced.ok) out[usdField] = priced.value.usd;
  }
  return out;
}

/** The blob-level provenance + basis, or the named reason there is none. */
function volumeUsdOverlay(
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): { usable: boolean; overlay: Row } {
  const usable = taoUsdUsable(reading, nowMs);
  if (!usable.ok)
    return { usable: false, overlay: { tao_usd_unavailable: usable.reason } };
  const r = reading as TaoUsdReading;
  return {
    usable: true,
    overlay: {
      tao_usd: {
        usd_per_tao: r.usd_per_tao as number,
        block_number: r.block_number ?? null,
        // No `?? null`: taoUsdUsable already refused any reading whose
        // observed_at does not parse, so by here it is a real stamp. A
        // fallback would be a branch that cannot be taken and cannot be
        // tested -- the kind that reads like a safeguard and is not one.
        observed_at: r.observed_at,
        price_basis: r.price_basis ?? null,
      },
      // Paired with tao_usd: the basis describes fields that exist, so it
      // appears exactly when they do.
      usd_pricing_basis: VOLUME_USD_PRICING_BASIS,
    },
  };
}

const withVolumeFieldSources = (blob: Row): Row => ({
  ...(typeof blob.field_sources === "object" && blob.field_sources
    ? (blob.field_sources as Row)
    : {}),
  buy_volume_usd: ALPHA_USD_FIELD_SOURCE,
  sell_volume_usd: ALPHA_USD_FIELD_SOURCE,
  total_volume_usd: ALPHA_USD_FIELD_SOURCE,
});

/** Decorate one subnet's 24h volume scorecard. */
export function withAlphaVolumeUsd(
  blob: Row | null | undefined,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): Row | null | undefined {
  if (!blob || typeof blob !== "object") return blob;
  const { usable, overlay } = volumeUsdOverlay(reading, nowMs);
  return {
    ...(usable
      ? priceTaoFields(blob, VOLUME_USD_FIELDS, reading as TaoUsdReading, nowMs)
      : blob),
    ...overlay,
    field_sources: withVolumeFieldSources(blob),
  };
}

/** Decorate the network-wide 24h volume blob: totals, spread, and per subnet. */
export function withChainAlphaVolumeUsd(
  blob: Row | null | undefined,
  reading: TaoUsdReading | null | undefined,
  nowMs: number,
): Row | null | undefined {
  if (!blob || typeof blob !== "object") return blob;
  const { usable, overlay } = volumeUsdOverlay(reading, nowMs);
  if (!usable) {
    return { ...blob, ...overlay, field_sources: withVolumeFieldSources(blob) };
  }
  const r = reading as TaoUsdReading;

  const network =
    blob.network && typeof blob.network === "object"
      ? priceTaoFields(blob.network as Row, VOLUME_USD_FIELDS, r, nowMs)
      : blob.network;

  return {
    ...blob,
    network,
    subnets: Array.isArray(blob.subnets)
      ? (blob.subnets as Row[]).map((s) =>
          priceTaoFields(s, VOLUME_USD_FIELDS, r, nowMs),
        )
      : blob.subnets,
    ...overlay,
    field_sources: withVolumeFieldSources(blob),
  };
}
