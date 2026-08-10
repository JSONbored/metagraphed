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
 * The newest TAO/USD reading from KV, or null.
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
): Promise<Row | null> {
  if (memo.env === env && now < memo.expiresAt) {
    return memo.value as Row | null;
  }
  const value = await readHealthKv(
    env as Parameters<typeof readHealthKv>[0],
    KV_TAO_USD_CURRENT,
  );
  if (value !== null) {
    memo = { env, value, expiresAt: now + TAO_USD_CURRENT_KV_TTL_MS };
  }
  return value as Row | null;
}

registerModuleStateReset("workers/tao-usd-current.ts", () => {
  memo = { env: null, value: null, expiresAt: 0 };
});
