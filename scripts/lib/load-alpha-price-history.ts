/**
 * Optional Postgres load of recent subnet_snapshots alpha prices for #7227.
 * Used by refresh-economics / build-artifacts when DATABASE_URL is set.
 * Returns null when the DB is unavailable so bake stays graceful.
 */
import { indexAlphaPriceHistoryByNetuid } from "../../src/alpha-price-change.ts";

/** Days of history needed for the 1m window, plus a few days of slack. */
export const ALPHA_PRICE_HISTORY_LOOKBACK_DAYS = 40;

export async function loadAlphaPriceHistoryByNetuid(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): Promise<ReturnType<typeof indexAlphaPriceHistoryByNetuid> | null> {
  if (!databaseUrl) return null;
  const { default: postgres } = await import("postgres");
  const sql = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    fetch_types: false,
    onnotice: () => {},
  });
  try {
    const lookbackDays = ALPHA_PRICE_HISTORY_LOOKBACK_DAYS;
    const rows = await sql`
      SELECT
        netuid,
        snapshot_date::text AS snapshot_date,
        alpha_price_tao
      FROM subnet_snapshots
      WHERE snapshot_date >= (CURRENT_DATE - (${lookbackDays} * INTERVAL '1 day'))
      ORDER BY netuid ASC, snapshot_date ASC
    `;
    return indexAlphaPriceHistoryByNetuid(rows);
  } catch (err) {
    console.warn(
      `::warning::alpha-price history load failed (${(err as Error)?.message || err}); economics bake continues with null change fields.`,
    );
    return null;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}
