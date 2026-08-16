// Rendering alpha in USD honestly (#10385).
//
// The bar was set by the TAO ticker in market.functions.ts: when a figure is
// not the quantity a reader assumes, SAY SO rather than swapping it silently.
// Market cap there is TotalIssuance x usd_per_tao -- the chain's own issuance,
// not a circulating-supply estimate, reading ~17% higher than the venues -- and
// volume is on-chain subnet-AMM volume, not global exchange volume. Both are
// relabelled rather than quietly presented as the familiar number.
//
// Alpha has three of its own, and each one is a way a correct-looking chart
// lies:
//
// 1. USD COVERAGE IS SHORTER THAN THE CHART. A subnet's TAO price series runs
//    ~13 months; the TAO/USD index runs from 2026-08-02 (#10382). A USD line
//    drawn across the whole window either truncates without saying so or, far
//    worse, applies today's rate backwards -- which renders perfectly and is
//    wrong at every point but the last. The API refuses to extrapolate and
//    publishes `usd_available_from`; the UI's job is to show that boundary
//    instead of letting a reader assume the line means what the TAO line means.
//
// 2. THE MARKET-CAP DENOMINATOR IS NOT THE ONE A READER EXPECTS (#10381).
//    `alpha_market_cap_tao` is priced against total_stake_alpha, so the USD
//    figure inherits that basis and has to name it.
//
// 3. A DECLINING INDEX IS NOT A ZERO. When the index publishes no price
//    (ADR 0025's `insufficient_pools`) or has gone stale, there is no USD
//    anywhere on the page. That must read as "unavailable" -- never as $0, and
//    never as the last number we happened to have.
//
// All three are decided here, as pure functions over what the API already
// states, so a component cannot render a USD figure by forgetting to ask.

import { readKey, readString } from "./read-key";

/** What a series payload states about its own USD coverage. */
export interface AlphaUsdSeriesLike {
  /** Oldest point carrying USD, ISO. Null when none does. */
  usd_available_from_iso?: string | null;
  /** Oldest priced day, for the date-keyed series. */
  usd_available_from?: string | number | null;
  /** How many points carry USD. */
  priced_candle_count?: number | null;
  priced_day_count?: number | null;
  /** How many points there are. */
  candle_count?: number | null;
  day_count?: number | null;
  /** Why NO point could be priced, or null/absent. */
  usd_unavailable?: string | null;
}

/**
 * Why there is no USD, in words a reader can act on.
 *
 * The API's reasons are precise and are not sentences. `index_unpriced` tells
 * an operator that ADR 0025's pool quorum was not met; it tells a reader
 * nothing. Translated here rather than rendered raw, and NOT collapsed to one
 * generic string -- "the price feed is briefly unavailable" and "we could not
 * reach the price feed" mean different things to someone deciding whether to
 * reload.
 */
export function alphaUsdUnavailableLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "index_unpriced":
      return "USD unavailable — too few qualifying liquidity pools to price TAO right now";
    case "index_stale":
      return "USD unavailable — the TAO/USD reading is older than we will price against";
    case "no_index_reading":
      return "USD unavailable — no TAO/USD reading yet";
    case "read_failed":
      return "USD unavailable — could not reach the TAO/USD index";
    case "no_alpha_price":
      return "USD unavailable — no alpha price to convert";
    default:
      return "USD unavailable";
  }
}

export interface AlphaUsdCoverage {
  /** Whether ANY point carries USD. False means render TAO only. */
  available: boolean;
  /** Set when `available` is false. Never shown alongside a USD figure. */
  unavailableLabel: string | null;
  /** Oldest point carrying USD (ISO date or YYYY-MM-DD), or null. */
  from: string | null;
  pricedCount: number;
  totalCount: number;
  /** True when USD covers only part of the charted window. */
  partial: boolean;
  /**
   * The line to render beside a USD series, or null when there is nothing to
   * qualify. Non-null whenever `partial` — that is the whole point.
   */
  caption: string | null;
}

const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

const asDate = (v: unknown): string | null => {
  if (typeof v === "string" && v.length > 0) return v.slice(0, 10);
  return null;
};

/**
 * What a component may say about a USD series.
 *
 * Reads only what the API STATES -- never counts nulls in the point array to
 * infer a boundary. Inferring it would put the UI in the business of deciding
 * where USD begins, which is exactly the decision #10382 moved server-side so
 * that every surface answers it the same way.
 */
/**
 * `unknown`, because that is what this receives.
 *
 * The body already opened with `if (!series || typeof series !== "object")`,
 * so it was written for arbitrary input -- but the signature promised
 * `AlphaUsdSeriesLike`, and its own test feeds it `42`, `"x"` and `[]` to
 * prove the guard works. The test could only do that by asserting, which meant
 * the guard's real contract lived in the test rather than in the type.
 */
export function alphaUsdCoverage(series: unknown): AlphaUsdCoverage {
  const none: AlphaUsdCoverage = {
    available: false,
    unavailableLabel: alphaUsdUnavailableLabel(undefined),
    from: null,
    pricedCount: 0,
    totalCount: 0,
    partial: false,
    caption: null,
  };
  if (!series || typeof series !== "object") return none;

  const priced = int(readKey(series, "priced_candle_count") ?? readKey(series, "priced_day_count"));
  const total = int(readKey(series, "candle_count") ?? readKey(series, "day_count"));
  const from =
    asDate(readKey(series, "usd_available_from_iso")) ??
    asDate(readKey(series, "usd_available_from"));
  // Checked, not assumed: alphaUsdUnavailableLabel switches on known reason
  // strings and falls through to a generic label, so a non-string here would
  // have been switched on and silently produced the generic message as though
  // the payload had said nothing at all.
  const unavailable = readString(series, "usd_unavailable");

  // A stated reason wins over any count. A payload that names why it could not
  // price must not be rendered as a series that merely happens to be empty.
  if (unavailable) {
    return {
      ...none,
      unavailableLabel: alphaUsdUnavailableLabel(unavailable),
      totalCount: total,
    };
  }
  if (priced === 0) return { ...none, totalCount: total };

  const partial = total > 0 && priced < total;
  return {
    available: true,
    unavailableLabel: null,
    from,
    pricedCount: priced,
    totalCount: total,
    partial,
    // Only when the two series disagree about how far back they go. A caption
    // on a fully-covered chart would be noise, and noise is what stops captions
    // being read on the charts that need them.
    caption: partial
      ? from
        ? `USD from ${from} — ${priced} of ${total} points priced. TAO history runs the full window.`
        : `USD covers ${priced} of ${total} points. TAO history runs the full window.`
      : null,
  };
}

/**
 * What `alpha_market_cap_usd` actually counts, for the tile that shows it.
 *
 * Mirrors market.functions.ts's `supply_basis`: the denominator is a property
 * of the figure, not a footnote, and a market cap whose basis is invisible
 * invites comparison with venue numbers computed a different way.
 */
export const ALPHA_MARKET_CAP_USD_NOTE =
  "Alpha market cap is total staked alpha x alpha price, converted at the TAO/USD index — not a circulating-supply estimate, and not comparable to a venue's market cap.";

/**
 * Every USD figure on the page is RECONSTRUCTED.
 *
 * The product of a measured alpha price and a measured TAO/USD index is our
 * arithmetic. Acceptance 1 is that no USD figure renders without this being
 * reachable, so the string lives beside the coverage logic rather than inside
 * one component.
 */
export const ALPHA_USD_PROVENANCE_NOTE =
  "USD figures are derived: an on-chain alpha price in TAO multiplied by our TAO/USD index (a liquidity-weighted median across qualifying wTAO/WETH pools, through an ETH/USDC anchor). They are not quoted by any venue.";
