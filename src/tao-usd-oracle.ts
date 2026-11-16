// The on-chain TAO/USD oracle serving builders (#13164) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool behind /network/tao-usd, so
// the three surfaces cannot drift. Pure + exported for tests; callers resolve
// the store (the native seam in tao-usd-oracle-store.ts) and hand the rows
// in.
//
// THE DECLINE IS NULL, NEVER A PRICE. The feed history's writers -- the
// engine's SubtensorModule.TaoUsdPrice / TaoUsdPriceOracle storage decode and
// TaoUsdPriceFed event decode -- land separately (#13164 defers them), so an
// empty table is not "the chain has no price": it is "the oracle capture has
// not run", and `oracle: null` on the tao-usd card is how the artifact says
// so. The off-chain composed index the card has always served is UNCHANGED
// and labelled source: "pool_composite"; this block is labelled
// source: "chain_oracle", so probe-derived vs on-chain is explicit rather
// than inferred.
import { selectedTaoUsdOracleStore } from "./tao-usd-oracle-store.ts";
import { u128TextOrNull } from "./subnet-gamma.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Finite and > 0, else null -- same bound the composed index serves under:
 * a zero or negative USD price is a broken read, and null already carries
 * the meaning "could not be priced". */
function positiveOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatFeed(row: Row): Row | null {
  const blockNumber = nonNegativeInt(row?.block_number);
  // A feed without its block names no chain state; drop it rather than serve
  // a price that cannot be pinned.
  if (blockNumber === null) return null;
  return {
    block_number: blockNumber,
    usd_per_tao: positiveOrNull(row?.usd_per_tao),
    observed_at: toIso(row?.observed_at),
  };
}

/**
 * The on-chain oracle block for the tao-usd card, or null.
 *
 * Null rows (no store bound -- today's deployed Workers -- or a failed read)
 * and an empty history both render as null: with no feed captured there is no
 * on-chain price to state, and a zeroed block would be the confident-zero
 * failure the composed index's own null-price contract exists to avoid. The
 * newest feed carries the current TaoUsdPrice; `feeds` is the TaoUsdPriceFed
 * history behind it, newest first and store-capped.
 */
export function buildTaoUsdOracle(rows: readonly Row[] | null): Row | null {
  if (rows === null) return null;
  const feeds = rows
    .map((row) => formatFeed(row))
    .filter((row): row is Row => row !== null);
  if (feeds.length === 0) return null;
  const newestRow = rows.find(
    (row) => nonNegativeInt(row?.block_number) !== null,
  );
  return {
    source: "chain_oracle",
    usd_per_tao: feeds[0].usd_per_tao,
    price_raw: u128TextOrNull(newestRow?.price_raw),
    oracle:
      typeof newestRow?.oracle === "string" && newestRow.oracle !== ""
        ? newestRow.oracle
        : null,
    block_number: feeds[0].block_number,
    observed_at: feeds[0].observed_at,
    captured_at: toIso(newestRow?.captured_at),
    fed_count: feeds.length,
    feeds,
  };
}

/**
 * The on-chain feed rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the composed index never has.
 */
export async function loadTaoUsdOracle(env: unknown): Promise<Row[] | null> {
  const store = selectedTaoUsdOracleStore(env);
  if (!store) return null;
  try {
    return await store.rows();
  } catch (error) {
    console.error("tao usd oracle store read failed:", error);
    return null;
  }
}
