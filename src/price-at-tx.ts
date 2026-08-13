import { round9 } from "./lib/rao.ts";
// Price-at-transaction for alpha-denominated stake events (#8369).
//
// The question a human actually asks about a stake event is "what was that
// worth?" — which needs the price at that event, not today's. This module
// answers it as a pure function over a row the API is ALREADY reading.
//
// Resolution: EXACT, not bucketed. A StakeAdded/StakeRemoved row carries both
// legs of the same swap — `alpha_amount` (alpha bought/sold) and `amount_tao`
// (TAO spent/received) — so that trade's own execution price is simply
// amount_tao / alpha_amount. That is the identical computation
// src/subnet-ohlc.ts performs per trade to BUILD its candles (see that
// module's header, and the OHLC contract text: "each row is one executed
// trade, price = amount_tao / alpha_amount").
//
// #8369 originally specified resolving from "the nearest OHLC bucket
// at-or-before the block timestamp", carrying price_basis "bucket_1h" |
// "bucket_1d". That was written before this data shape was confirmed, and
// reading a bucket back would be strictly WORSE: a bucket is an aggregate OF
// these very trades, so it would answer with a neighbourhood average when the
// row itself holds the exact figure — and it would add the windowed join the
// issue's own performance requirement is worried about. The honest basis is
// therefore "trade_exact", and there is no join, no N+1, and no measurable
// read-path cost (one division per row already in memory).
//
// `usd_at_tx` USED TO BE OUT OF SCOPE, AND THAT PREMISE IS NOW FALSE (#8602).
//
// This module used to say a USD figure was impossible here: no TAO/USD history
// existed anywhere in the system, and the product's only fiat price was a live
// third-party ticker read in the browser. Both facts changed. `tao_usd_index`
// has been written about once a minute since 2026-08-02, it is FIRST-PARTY --
// a liquidity-weighted median across qualifying wTAO/WETH pools through an
// ETH/USDC anchor, per ADR 0025, not a venue quote -- and the UI stopped
// calling coinpaprika entirely.
//
// So the objection that stood was never "USD is unknowable from chain data".
// It was "we do not have a first-party rate, and putting someone else's feed
// on the data plane is not a trade this project makes". We have one now.
//
// The fiat companion is therefore provided, and its BASIS is deliberately a
// different word from `price_basis`. `trade_exact` means the alpha price came
// from this row's own two legs and is exact. `index_at_or_before` means the
// dollar leg is a LOOKUP against the newest index reading at-or-before the
// event -- a different kind of claim, and a consumer must be able to tell
// them apart rather than reading one confidence off the other.
//
// Root subnet (netuid 0) has no AMM pool — staking there is 1:1 TAO<->TAO
// with no price impact (mirrors src/stake-quote.ts's and src/subnet-ohlc.ts's
// own root short-circuits) — so a "price" for it would be a meaningless
// constant 1.0. Root rows resolve to a null price with basis
// "root_no_pool" rather than a number that invites false comparison.

/** How a `price_at_tx` was arrived at. Honest precision labelling — the UI
 * surfaces this so a reader is never guessing what they're looking at. */
export type PriceBasis = "trade_exact" | "root_no_pool";

export interface PriceAtTx {
  /** TAO per alpha for this specific trade, or null when not derivable. */
  price_at_tx: number | null;
  price_basis: PriceBasis | null;
}

/** How a `usd_at_tx` was arrived at. A LOOKUP, never an exact trade figure. */
export type UsdAtTxBasis = "index_at_or_before";

export interface UsdAtTx {
  /** USD per alpha at this trade, or null when no rate existed for it. */
  usd_at_tx: number | null;
  usd_basis: UsdAtTxBasis | null;
}

/**
 * The fiat companion to `price_at_tx` (#8602).
 *
 * NULL when the event predates the index's own history, which is the case the
 * issue is most explicit about: the index starts when we started collecting,
 * and carrying the oldest rate backwards would be fabrication dressed as data.
 * The caller resolves readings per instant (loadTaoUsdAtInstants), so an event
 * with no rate simply has no entry -- absence here means "no rate existed",
 * never "the rate was null".
 *
 * NOT rounded to rao: this is a dollar figure, and rao precision is a property
 * of TAO amounts. Presentation rounding belongs to the surface, the same rule
 * src/alpha-usd.ts states for every other USD field.
 */
export function resolveUsdAtTx(
  priceAtTx: number | null,
  usdPerTao: number | null | undefined,
): UsdAtTx {
  // ZERO IS A PRICE on the alpha side (a pool with no TAO in it), so only
  // null/non-finite is refused -- the same line alpha-usd.ts draws. A
  // non-positive RATE is refused outright: the index publishes null rather
  // than zero when it cannot price, so a zero here is a corrupt reading.
  if (priceAtTx === null || !Number.isFinite(priceAtTx))
    return { usd_at_tx: null, usd_basis: null };
  if (
    usdPerTao === null ||
    usdPerTao === undefined ||
    !Number.isFinite(usdPerTao) ||
    usdPerTao <= 0
  )
    return { usd_at_tx: null, usd_basis: null };
  return {
    usd_at_tx: priceAtTx * usdPerTao,
    usd_basis: "index_at_or_before",
  };
}

// The price denominator: zero/negative/non-finite must never reach the
// division (Infinity/NaN/a nonsensical negative price). Same guard as
// subnet-ohlc.ts's positiveFinite.
function positiveFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The price numerator. Unlike the denominator a zero/negative cell is still
// arithmetically safe to carry, so only non-finite values are rejected —
// same guard as subnet-ohlc.ts's finiteAmount.
function finiteAmount(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve one event row's alpha execution price.
 *
 * Null-safe by construction: any row that isn't a two-legged alpha swap — a
 * Transfer, a registration, a root-subnet stake, or a malformed/missing
 * amount — yields `{ price_at_tx: null, price_basis: null }` (or
 * `"root_no_pool"` for root) rather than a fabricated number. Never throws.
 *
 * Callers pass the raw row the read path already has; this adds no query.
 */
export function resolvePriceAtTx(
  row: Record<string, unknown> | null | undefined,
): PriceAtTx {
  if (!row || typeof row !== "object")
    return { price_at_tx: null, price_basis: null };

  // Root has no pool, so there is no price to state. Distinguished from
  // "unknown" with its own basis: the absence is a fact about root, not a
  // gap in our data.
  //
  // The null/empty check is load-bearing, not defensive: `Number(null)` and
  // `Number("")` are both 0, so a bare Number() coercion reports every
  // subnet-less event (a Transfer carries netuid null) as "root_no_pool" --
  // a wrong, confidently-stated reason. Caught by an end-to-end check
  // against real row shapes; the unit test below pins it.
  const rawNetuid = row.netuid;
  if (rawNetuid != null && rawNetuid !== "") {
    const netuid = Number(rawNetuid);
    if (Number.isFinite(netuid) && netuid === 0) {
      return { price_at_tx: null, price_basis: "root_no_pool" };
    }
  }

  const alpha = positiveFinite(row.alpha_amount);
  const tao = finiteAmount(row.amount_tao);
  if (alpha === null || tao === null)
    return { price_at_tx: null, price_basis: null };

  const price = tao / alpha;
  if (!Number.isFinite(price)) return { price_at_tx: null, price_basis: null };

  return { price_at_tx: round9(price), price_basis: "trade_exact" };
}

/**
 * Decorate already-formatted events with their fiat companion (#8602).
 *
 * AN OVERLAY, NOT A SECOND PARAMETER ON formatAccountEvent. That formatter is
 * used as a bare `.map(formatAccountEvent)` in several modules, so a second
 * positional argument would silently receive the array INDEX -- a wrong rate
 * on every row, stated confidently, with nothing to catch it. Keeping the
 * formatter one-argument makes that impossible rather than merely unlikely.
 *
 * `usdByInstant` is keyed by the event's epoch-ms instant, which is what
 * loadTaoUsdAtInstants returns. An event whose instant is absent from the map
 * predates the index and gets nulls -- see resolveUsdAtTx.
 */
export function withUsdAtTx<T extends Record<string, unknown>>(
  events: readonly T[] | null | undefined,
  usdByInstant: Map<number, { usd_per_tao: number | null }> | null | undefined,
  // PARTIAL, not `T & UsdAtTx`: on a failed lookup the fields are genuinely
  // ABSENT rather than present-and-null, because "we could not read the index"
  // is not the same claim as "no rate existed for this event". The type says
  // so rather than promising a field the function does not always add.
): Array<T & Partial<UsdAtTx>> {
  const list = Array.isArray(events) ? events : [];
  if (!usdByInstant) return [...list];
  return list.map((event) => {
    const at =
      typeof event?.observed_at === "string"
        ? Date.parse(event.observed_at)
        : Number.NaN;
    const reading = Number.isFinite(at) ? usdByInstant.get(at) : undefined;
    return {
      ...event,
      ...resolveUsdAtTx(
        typeof event?.price_at_tx === "number" ? event.price_at_tx : null,
        reading?.usd_per_tao,
      ),
    };
  });
}
