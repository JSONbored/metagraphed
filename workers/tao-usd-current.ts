// The newest TAO/USD reading, shared by every surface that prices alpha in USD.
//
// Extracted from workers/api.ts (#10383). It started there because /economics
// was the only caller (#10381), but the volume routes are LIVE handlers in
// workers/request-handlers/ rather than the artifact-dispatch seam, and they
// cannot import workers/api.ts -- api.ts imports them. Two copies of a memoised
// reader would be two caches with one name, and the second one to be written
// would be the one nobody remembered to reset between test files.
//
// WHY KV AND NOT NEON: see KV_TAO_USD_CURRENT in src/kv-keys.ts. The short
// version is that these routes otherwise touch no database, and adding a
// Postgres round trip to a market-depth card to fetch one scalar would make the
// dependency graph worse than the feature is worth.

import { readHealthKv } from "./storage.ts";
import { KV_TAO_USD_CURRENT } from "../src/kv-keys.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";
import type { TaoUsdReading } from "../src/alpha-usd.ts";

type Row = Record<string, unknown>;

/**
 * How long a reading is reused within one isolate.
 *
 * 60 s, far below the two-hour freshness bound src/alpha-usd.ts enforces, so
 * the memo can never extend how long a stale rate is allowed to serve -- it
 * only avoids re-reading the same blob for every request in a burst.
 */
export const TAO_USD_CURRENT_KV_TTL_MS = 60_000;

let memo: { env: unknown; value: unknown; expiresAt: number } = {
  env: null,
  value: null,
  expiresAt: 0,
};

/**
 * `observed_at` as an ISO string, whatever the stored value looks like.
 *
 * The producer wrote `observed_at` as the raw epoch-ms integer it holds
 * in `tao_usd_index`, while `TaoUsdReading` declares a string and
 * `taoUsdUsable` grades it with `Date.parse`. `Date.parse(1786564800000)`
 * stringifies the number and fails to parse it -- NaN -- and an unparseable
 * stamp is deliberately graded `index_stale` rather than fresh. So a cache
 * rewritten EVERY MINUTE was read as hours old on every request, and
 * /economics, /subnets/{netuid}/volume and /chain/alpha-volume served
 * `tao_usd_unavailable: "index_stale"` permanently.
 *
 * Accepts both forms rather than only the fixed one: values written before the
 * producer fix are still in KV, and a reader that only understood the new shape
 * would keep declining until the next tick overwrote them.
 */
function observedAtIso(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The newest TAO/USD reading from KV, or null.
 *
 * Returns a NORMALISED `TaoUsdReading` rather than the raw blob. Every caller
 * used to cast the bag with `as TaoUsdReading`, which is what let the
 * epoch-ms/ISO mismatch above typecheck for as long as it did: an unchecked
 * cast asserts a shape instead of establishing one.
 *
 * A NULL IS NOT MEMOISED. A cold or unbound store stays re-queried rather than
 * being cached as absent for a minute -- otherwise the first request after a
 * deploy would decide, for the whole isolate, that the index does not exist.
 *
 * Keyed on `env` so tests and multi-binding callers never cross-read.
 */
export async function readTaoUsdCurrentKv(
  env: unknown,
  now: number = Date.now(),
): Promise<TaoUsdReading | null> {
  if (memo.env === env && now < memo.expiresAt) {
    return memo.value as TaoUsdReading | null;
  }
  const value = await readHealthKv(
    env as Parameters<typeof readHealthKv>[0],
    KV_TAO_USD_CURRENT,
  );
  if (value === null) return null;
  const row = value as Row;
  const reading: TaoUsdReading = {
    usd_per_tao:
      typeof row.usd_per_tao === "number" && Number.isFinite(row.usd_per_tao)
        ? row.usd_per_tao
        : null,
    observed_at: observedAtIso(row.observed_at),
    block_number:
      typeof row.block_number === "number" && Number.isInteger(row.block_number)
        ? row.block_number
        : null,
    price_basis: typeof row.price_basis === "string" ? row.price_basis : null,
  };
  memo = { env, value: reading, expiresAt: now + TAO_USD_CURRENT_KV_TTL_MS };
  return reading;
}

registerModuleStateReset("workers/tao-usd-current.ts", () => {
  memo = { env: null, value: null, expiresAt: 0 };
});
