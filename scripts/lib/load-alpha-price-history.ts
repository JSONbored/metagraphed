/**
 * Load recent subnet_snapshots alpha prices for #7227's change fields.
 * Used by refresh-economics / build-artifacts. Returns null when the store is
 * unreachable so the bake stays graceful (null change fields, never a failure).
 *
 * NEON, over a plain `pg` connection (#10179's follow-up). The history has
 * moved twice: the box's Postgres, then D1 over the Cloudflare HTTP door, and
 * now Neon -- `subnet_snapshots` is in NEON_SOLE_STORE_TABLES and D1 is being
 * dropped, so the HTTP door is about to answer 404 for a database that no
 * longer exists.
 *
 * THE GRACEFUL FAILURE IS THE DANGEROUS PART, which is the whole history of
 * this file. Between the box wipe and 2026-08-03 every `alpha_price_change_*`
 * field served null: the loader was asking a destroyed database, failing
 * gracefully, and a graceful failure looks exactly like "no change data
 * exists". Leaving it on D1 through the drop would repeat that verbatim.
 *
 * It matters more than the R2/KV shadowing suggests. `resolveLiveEconomics`
 * REJECTS a KV blob older than ECONOMICS_FRESHNESS_MAX_AGE_MS and falls back to
 * this artifact, so the baked fields are exactly what serves when the live
 * refresh is wedged -- the case where they are least likely to be noticed and
 * most likely to be needed.
 *
 * A CONNECTION, not the Workers binding: this runs in the publish pipeline
 * (node), where there is no Hyperdrive binding. `DATABASE_URL` is resolved from
 * NEON_API_KEY in the workflow, the same way scripts/neon-migrate.ts gets it.
 */
import pg from "pg";

import { indexAlphaPriceHistoryByNetuid } from "../../src/alpha-price-change.ts";

/** Days of history needed for the 1m window, plus a few days of slack. */
export const ALPHA_PRICE_HISTORY_LOOKBACK_DAYS = 40;

/** The `pg` surface this needs, so a test can hand in a fake. */
export interface PgLike {
  /** `Promise<unknown>`, because a real `pg.Client.connect()` resolves to the
   *  client and this module awaits it for the side effect. Declaring
   *  `Promise<void>` did not make anything safer -- it made `pg.Client` fail
   *  to match, and the assertion that papered over it also stopped the
   *  compiler checking `query` and `end` at the same call. */
  connect(): Promise<unknown>;
  end(): Promise<void>;
  query(text: string): Promise<{ rows?: unknown[] } | undefined>;
}

export interface AlphaPriceHistoryEnv {
  DATABASE_URL?: string | undefined;
  /** `process.env` is the production caller; the index signature keeps it
   * assignable without widening what this module actually reads. */
  [key: string]: string | undefined;
}

/**
 * The cutoff as a DATE LITERAL, computed here rather than by the database.
 *
 * THIS QUERY HAS TWO ENGINES BEHIND IT, which is the whole reason the cutoff
 * moved out of the SQL. `loadAlphaPriceHistoryByNetuid` below sends it to D1
 * over HTTP at build time; `src/live-economics-refresh.ts` sends the same text
 * through `readStore`, which is Postgres. It used to read
 * `date('now','-40 days')` -- SQLite's spelling, and `function date(unknown,
 * unknown) does not exist` on Postgres, verified against the live database.
 *
 * The failure was total rather than partial: the read sits inside
 * refreshLiveEconomics's own try, so the throw took the WHOLE tick and KV
 * `economics:current` simply stopped advancing -- with the last good blob still
 * being served, which is what made it look like nothing was wrong.
 *
 * Computing the date in JS is the same move #9798 made for the neuron_daily
 * window, and for the same reason: it removes the dialect from the question
 * instead of translating it. A quoted `YYYY-MM-DD` literal compares correctly
 * against `snapshot_date` on both engines, and there is no date function left
 * for two dialects to disagree about.
 *
 * Inlined rather than bound because one of the two callers is an HTTP door with
 * no bind slot, and the value is generated from a number rather than accepted
 * from one.
 */
export function alphaPriceHistoryCutoff(
  lookbackDays: number = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  now: () => number = Date.now,
): string {
  const cutoff = now() - Math.trunc(lookbackDays) * 86_400_000;
  return new Date(cutoff).toISOString().slice(0, 10);
}

export function alphaPriceHistoryQuery(
  lookbackDays: number = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS,
  now: () => number = Date.now,
): string {
  return (
    // captured_at is load-bearing, not decoration (#9449): a snapshot row is
    // upserted repeatedly through its own day, so `snapshot_date` says WHICH
    // day a row belongs to and nothing at all about how far apart two rows
    // actually are. Two consecutive dates were measured one hour apart.
    "SELECT netuid, snapshot_date, alpha_price_tao, captured_at " +
    "FROM subnet_snapshots " +
    `WHERE snapshot_date >= '${alphaPriceHistoryCutoff(lookbackDays, now)}' ` +
    "ORDER BY netuid ASC, snapshot_date ASC"
  );
}

export async function loadAlphaPriceHistoryByNetuid(
  env: AlphaPriceHistoryEnv = process.env,
  clientFactory: (connectionString: string) => PgLike = (connectionString) =>
    new pg.Client({ connectionString }),
): Promise<ReturnType<typeof indexAlphaPriceHistoryByNetuid> | null> {
  const connectionString = env.DATABASE_URL;
  // No connection string is the ordinary local/PR case: bake with null change
  // fields rather than failing a build that has no business talking to
  // production.
  if (!connectionString) return null;

  const client = clientFactory(connectionString);
  try {
    await client.connect();
    const result = await client.query(alphaPriceHistoryQuery());
    const rows = result?.rows;
    // An empty result is a real answer (no history yet), but a MISSING rows
    // array is a shape we do not understand -- decline rather than bake a
    // confident "no changes" from it.
    if (!Array.isArray(rows)) throw new Error("no rows array in the response");
    return indexAlphaPriceHistoryByNetuid(rows as Record<string, unknown>[]);
  } catch (err) {
    console.warn(
      `::warning::alpha-price history load failed (${(err as Error)?.message || err}); economics bake continues with null change fields.`,
    );
    return null;
  } finally {
    // Awaited, and its own failure swallowed: a publish run is a short-lived
    // process, but leaving the socket open holds the job open behind it.
    await client.end().catch(() => undefined);
  }
}
