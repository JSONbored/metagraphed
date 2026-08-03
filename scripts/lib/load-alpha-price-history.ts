/**
 * Load recent subnet_snapshots alpha prices for #7227's change fields.
 * Used by refresh-economics / build-artifacts. Returns null when the store is
 * unreachable so the bake stays graceful (null change fields, never a failure).
 *
 * D1, NOT Postgres (2026-08-03). The box's Postgres was the original source and
 * it no longer exists; `subnet_snapshots` lives in D1 now
 * (METAGRAPH_SUBNET_SNAPSHOTS_SOURCE), carrying the same daily rows. Between
 * the wipe and this change every `alpha_price_change_*` field on
 * /api/v1/economics served null -- the loader was asking a destroyed database,
 * failing gracefully, and the graceful failure looked exactly like "no change
 * data exists". The KV economics blob SHADOWS the R2 artifact, so those nulls
 * masked the artifact rather than falling back to it.
 *
 * Read over the HTTP door, not the Workers binding: this runs in the publish
 * pipeline (node), where there is no D1 binding -- and the binding's 100-param
 * cap would not matter here anyway, since the query binds nothing.
 */
import { indexAlphaPriceHistoryByNetuid } from "../../src/alpha-price-change.ts";

/** Days of history needed for the 1m window, plus a few days of slack. */
export const ALPHA_PRICE_HISTORY_LOOKBACK_DAYS = 40;

/** The bounded D1 database that holds subnet_snapshots (wrangler.jsonc's
 * METAGRAPH_HEALTH_DB). Committed, not secret -- the API token is the
 * credential. */
export const SUBNET_SNAPSHOTS_D1_DATABASE_ID =
  "8e14c15f-d0b0-4ffd-ad65-01e37993efcf";

export interface AlphaPriceHistoryEnv {
  CLOUDFLARE_ACCOUNT_ID?: string | undefined;
  CLOUDFLARE_API_TOKEN?: string | undefined;
  METAGRAPH_D1_DATABASE_ID?: string | undefined;
  /** `process.env` is the production caller; the index signature keeps it
   * assignable without widening what this module actually reads. */
  [key: string]: string | undefined;
}

interface D1HttpResult {
  success?: boolean;
  errors?: { message?: string }[];
  result?: { results?: Record<string, unknown>[] }[];
}

/**
 * SQLite date arithmetic, not Postgres': `date('now','-40 days')` is the
 * D1 spelling of `CURRENT_DATE - 40 * INTERVAL '1 day'`. Inlined rather than
 * bound because the lookback is a module constant, never caller input.
 */
export function alphaPriceHistoryQuery(
  lookbackDays: number = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
): string {
  return (
    "SELECT netuid, snapshot_date, alpha_price_tao FROM subnet_snapshots " +
    `WHERE snapshot_date >= date('now','-${Math.trunc(lookbackDays)} days') ` +
    "ORDER BY netuid ASC, snapshot_date ASC"
  );
}

export async function loadAlphaPriceHistoryByNetuid(
  env: AlphaPriceHistoryEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ReturnType<typeof indexAlphaPriceHistoryByNetuid> | null> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const databaseId =
    env.METAGRAPH_D1_DATABASE_ID || SUBNET_SNAPSHOTS_D1_DATABASE_ID;
  // No credentials is the ordinary local/PR case: bake with null change fields
  // rather than failing a build that has no business talking to production.
  if (!accountId || !apiToken) return null;

  try {
    const response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: alphaPriceHistoryQuery() }),
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as D1HttpResult;
    if (body.success === false) {
      throw new Error(
        body.errors?.map((e) => e.message).join("; ") || "d1 query failed",
      );
    }
    const rows = body.result?.[0]?.results;
    // An empty result is a real answer (no history yet), but a MISSING result
    // envelope is a shape we do not understand -- decline rather than bake a
    // confident "no changes" from it.
    if (!Array.isArray(rows)) throw new Error("d1 response had no results");
    return indexAlphaPriceHistoryByNetuid(rows);
  } catch (err) {
    console.warn(
      `::warning::alpha-price history load failed (${(err as Error)?.message || err}); economics bake continues with null change fields.`,
    );
    return null;
  }
}
