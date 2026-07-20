// Serve-time enrichment of economics listing rows with alpha_price_change_*
// (#7227). Loads recent subnet_snapshots prices via the Postgres tier (same
// flag as /trajectory) and attaches derived %-change fields. Cold tier →
// schema-stable null fields, never an error.

import { tryPostgresTier } from "../workers/postgres-tier.mjs";
import {
  enrichEconomicsBlob,
  indexPriceHistoryByNetuid,
} from "./alpha-price-change.mjs";

const HISTORY_PATH = "/api/v1/economics/alpha-price-history";
// Cover the longest window (1m = 30d) with a small pad for sparse days.
const LOOKBACK_DAYS = 35;

function historyRequest(request) {
  const base =
    request?.url && typeof request.url === "string"
      ? request.url
      : "https://metagraph.internal/";
  const url = new URL(HISTORY_PATH, base);
  url.searchParams.set("days", String(LOOKBACK_DAYS));
  return new Request(url.toString(), {
    method: "GET",
    headers: request?.headers,
  });
}

/**
 * Fetch recent per-subnet alpha prices from Postgres (or null on miss).
 * @returns {Promise<Map<number, Array>|null>}
 */
export async function loadAlphaPriceHistory(env, request) {
  const body = await tryPostgresTier(
    env,
    historyRequest(request),
    "METAGRAPH_SUBNET_SNAPSHOTS_SOURCE",
  );
  if (!body || !Array.isArray(body.rows)) return null;
  return indexPriceHistoryByNetuid(body.rows);
}

/**
 * Attach alpha_price_change_* to every economics row. Always returns a blob
 * whose rows carry the four fields (null when history is unavailable).
 */
export async function withAlphaPriceChanges(env, request, blob) {
  if (!blob || typeof blob !== "object" || !Array.isArray(blob.subnets)) {
    return blob;
  }
  const history = env ? await loadAlphaPriceHistory(env, request) : null;
  return enrichEconomicsBlob(blob, history);
}
