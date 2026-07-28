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
// Deliberately NOT provided: a USD figure. #8369 also asks for `usd_at_tx`,
// but no TAO/USD history exists anywhere in this system — no column in
// deploy/postgres/schema.sql, no field in any route schema, and no ingestion
// job. The only TAO/USD in the product is a LIVE spot read from a third-party
// ticker performed in the browser (apps/ui/src/lib/metagraphed/market.functions.ts),
// never stored. A dollar price also cannot be derived from chain data on
// principle: nothing on Bittensor denominates in USD, so that rate only
// exists on off-chain venues. Adding it would mean putting a third-party
// price feed on the data plane, which this project deliberately avoids —
// everything here stays first-party, derived from chain data we index
// ourselves. See the scope note on #8369.
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

// Rao-precision rounding, matching the roundUnit helpers in subnet-ohlc.ts /
// chain-alpha-volume.ts (each module keeps its own copy by this codebase's
// convention, so each stays independently reviewable).
//
// Unlike those, this one carries no `!Number.isFinite` guard: they round
// accumulator sums from several call sites, whereas this has exactly one
// caller which finiteness-checks the quotient immediately before calling —
// so a guard here would be unreachable by construction rather than
// defensive, and unreachable code is worse than no code.
const RAO_PER_UNIT = 1e9;
function roundUnit(value: number): number {
  return Math.round(value * RAO_PER_UNIT) / RAO_PER_UNIT;
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

  return { price_at_tx: roundUnit(price), price_basis: "trade_exact" };
}
