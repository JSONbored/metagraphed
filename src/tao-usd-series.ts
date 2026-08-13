import { round9 } from "./lib/rao.ts";
// GET /api/v1/network/tao-usd (#9609): what one TAO is worth in USD, how that
// figure was derived, and how it has moved.
//
// The SERVING side of src/tao-usd-index.ts, which computes the index but has
// never had a reader. `tao_usd_index` has been written about once a minute
// since 2026-08-02 -- 5,660 rows measured 2026-08-06 -- and no SELECT touched
// it anywhere in the repo. Every monetary figure this API publishes is
// TAO-denominated; this is the USD axis they all need, already captured.
//
// ## THE PRICE IS DERIVED, SO THE DERIVATION IS PART OF THE ANSWER
//
// There is no TAO/USD pair on chain. Per ADR 0025 the producer takes a
// LIQUIDITY-WEIGHTED median across qualifying wTAO/WETH pools, rejects pools
// more than 2% from the unweighted median, refuses to publish below a two-pool
// floor, and multiplies through an ETH/USDC anchor leg. A bare scalar would be
// a number a caller has no way to audit, so `price_basis`, `eth_usd`,
// `pool_count` and the stored per-pool breakdown ride along with the latest
// reading.
//
// A NULL PRICE IS A STATED OUTCOME, NOT A GAP. The producer writes
// `price_basis: insufficient_pools` with a NULL `usd_per_tao` when the quorum
// was not met, and tests/fixtures/sqlite-schema/0004_user_state.sql enforces that pairing as a
// CHECK constraint. Coalescing it to 0 here would erase the one distinction the
// producer and the schema both went to the trouble of recording, and would
// publish "TAO is worthless" where the truth is "not priceable at that block".
//
// ## THE SERIES IS DAYS DEEP, NOT MONTHS
//
// It starts 2026-08-02. The window vocabulary offers 30d because the table
// accrues and will grow into it, but a caller asking for 30d today receives
// everything that exists -- which is why `point_count` and the oldest returned
// point are published rather than left to be inferred from an array length. A
// young series read as a complete one is how a four-day chart becomes a claim
// about the month.

import {
  TAO_USD_MAX_AGE_MS,
  taoUsdUsable,
  type TaoUsdReading,
} from "./alpha-usd.ts";

type Row = Record<string, unknown>;

/**
 * Age of a stored reading in ms, or null when it cannot say when it was taken.
 *
 * NOT `Number(row.observed_at)`. `Number(null)` and `Number("")` are both 0,
 * which is FINITE -- a missing stamp would come out as "aged since the epoch",
 * a 56-year-old reading reported as a number rather than as unknown. Only a
 * real number, or a string that says one, is accepted.
 */
function readingAgeMs(row: Row, nowMs: number): number | null {
  const raw = row?.observed_at;
  const observed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(observed)) return null;
  return nowMs - observed;
}

/**
 * Whether the newest reading is too old to price against.
 *
 * A reading that cannot say WHEN it was taken counts as STALE, never fresh --
 * defaulting the unknown direction to "current" is exactly how a frozen rate
 * survives a staleness check, and src/alpha-usd.ts makes the same call.
 */
function isStale(row: Row, nowMs: number): boolean {
  const age = readingAgeMs(row, nowMs);
  return age === null ? true : age > TAO_USD_MAX_AGE_MS;
}

/** The minimal store surface used here -- the owned query() verb, served by
 * both readStore and the producer store -- so tests can inject a plain
 * object. */
export interface TaoUsdSeriesDb {
  query?<Row>(text: string, values?: unknown[]): Promise<Row[]>;
}

export const TAO_USD_TABLE = "tao_usd_index";

/** Windows the route accepts (label -> hours), and the default. */
export const TAO_USD_WINDOWS: Record<string, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};
export const DEFAULT_TAO_USD_WINDOW = "24h";

/**
 * Points returned per request.
 *
 * The producer writes about once a minute, so 30d is ~43,200 rows -- more than
 * any caller charts and a large body to build. Newest-first with a cap means a
 * wide window returns the most RECENT slice rather than a series truncated from
 * the wrong end, and `point_count` reports what actually came back.
 */
export const TAO_USD_MAX_POINTS = 2000;

/**
 * One window of readings, newest first. Null when the read fails.
 *
 * Selects the whole row rather than just the price: the newest row carries the
 * provenance, and fetching that separately would risk pairing a price from one
 * block with a pool set read at another.
 */
export async function loadTaoUsdSeries(
  db: TaoUsdSeriesDb | null | undefined,
  { windowHours, now = Date.now }: { windowHours: number; now?: () => number },
): Promise<Row[] | null> {
  if (!db?.query) return null;
  try {
    const cutoff = now() - windowHours * 60 * 60 * 1000;
    return await db.query<Row>(
      `SELECT block_number, observed_at, usd_per_tao, price_basis,` +
        ` eth_usd, pool_count, pools FROM ${TAO_USD_TABLE}` +
        ` WHERE observed_at >= ?` +
        ` ORDER BY observed_at DESC LIMIT ${TAO_USD_MAX_POINTS}`,
      [cutoff],
    );
  } catch {
    return null;
  }
}

/**
 * The newest reading, in the shape `taoUsdUsable` grades.
 *
 * For callers that need the RATE and not the series -- revenue coverage and
 * owner-cut price one scalar each and would otherwise pull 2000 rows to read
 * the first. `LIMIT 1` on the same index the series query already uses.
 *
 * Returns the newest row WITHOUT skipping unpriced ones. A row carrying
 * `price_basis: insufficient_pools` is the current state of the index, and
 * stepping back to an older priced row would serve a rate past its freshness
 * bound while looking healthy -- the failure ADR 0025 published the basis to
 * make visible. `taoUsdUsable` tells `index_unpriced` from `index_stale`; this
 * function's job is to report, not to choose.
 *
 * Null means the read failed or the table is empty, which is a third state
 * again (`no_index_reading`) and equally not a price.
 */
export async function loadLatestTaoUsdReading(
  db: TaoUsdSeriesDb | null | undefined,
): Promise<TaoUsdReading | null> {
  if (!db?.query) return null;
  try {
    const rows = await db.query<Row>(
      `SELECT block_number, observed_at, usd_per_tao, price_basis` +
        ` FROM ${TAO_USD_TABLE}` +
        ` ORDER BY observed_at DESC LIMIT 1`,
    );
    const row = rows?.[0];
    if (!row) return null;
    return {
      usd_per_tao: positiveOrNull(row.usd_per_tao),
      observed_at: toIsoOrNull(row.observed_at),
      block_number: intOrNull(row.block_number),
      price_basis: typeof row.price_basis === "string" ? row.price_basis : null,
    };
  } catch {
    return null;
  }
}

/**
 * Shape the card. Pure, so the same rows produce the same payload wherever they
 * came from.
 *
 * Rows arrive NEWEST FIRST. `change_usd`/`change_pct` describe the movement
 * across the RETURNED window and are null when there is nothing to compare
 * against -- a single point has no change, and a change from a zero base has no
 * percentage.
 */
export function buildTaoUsdSeries(
  rows: Row[] | null | undefined,
  {
    window,
    includePoints = true,
    now = Date.now,
  }: { window?: unknown; includePoints?: boolean; now?: () => number } = {},
): Row {
  // ONE clock reading for the whole response.
  //
  // `stale` and `age_ms` are two statements about the SAME reading, and calling
  // now() once per field lets them describe different instants. A response can
  // then say `stale: false` beside an `age_ms` above its own `stale_after_ms` --
  // internally contradictory, and a caller re-deriving staleness from the age
  // gets a different answer than the one the API stated. Sampling the clock
  // once makes that disagreement unrepresentable rather than merely unlikely.
  const nowMs = now();

  const points = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      observed_at: toIsoOrNull(r?.observed_at),
      block_number: intOrNull(r?.block_number),
      // NOT `?? 0`. A null here is `insufficient_pools`, a stated outcome the
      // CHECK constraint guarantees is paired with that basis.
      usd_per_tao: positiveOrNull(r?.usd_per_tao),
    }))
    .filter((p) => p.observed_at !== null);

  // The change is computed over PRICED points only. An unpriced block is not a
  // price of zero, so letting one bound the window would invent a crash or a
  // recovery that never happened.
  const priced = points.filter(
    (p): p is typeof p & { usd_per_tao: number } => p.usd_per_tao !== null,
  );
  const newest = priced.length ? priced[0].usd_per_tao : null;
  const oldest = priced.length ? priced[priced.length - 1].usd_per_tao : null;
  const changeUsd =
    newest === null || oldest === null || priced.length < 2
      ? null
      : round9(newest - oldest);

  const newestRow = Array.isArray(rows) && rows.length ? rows[0] : null;
  return {
    schema_version: 1,
    window: window ?? null,
    point_count: points.length,
    // How many of those carried a price. A gap between the two is the signal
    // that the index could not be computed for part of the window, and
    // collapsing them into one number would hide it.
    priced_point_count: priced.length,
    // The whole latest reading, kept together so the price and the provenance
    // that produced it always describe the same block.
    latest: newestRow ? latestReading(newestRow) : null,
    oldest_observed_at: points.length
      ? points[points.length - 1].observed_at
      : null,
    // STALENESS IS STATED, NOT INFERRED (#8601 requirement 3).
    //
    // `latest.observed_at` was always there, but making every consumer parse
    // it, know TAO_USD_MAX_AGE_MS, and compare correctly is three chances to
    // get it wrong -- and a consumer that skips the check reads a frozen rate
    // as a current one, which is #9704's shape: a value with no live writer
    // behind it, served at 200 OK.
    //
    // The bound is the one src/alpha-usd.ts already refuses to multiply by, so
    // "this response says stale" and "no USD figure anywhere on the API" are
    // the same condition rather than two thresholds that can drift apart.
    stale: newestRow ? isStale(newestRow, nowMs) : true,
    stale_after_ms: TAO_USD_MAX_AGE_MS,
    // How old the newest reading actually is, so a caller can show "3 minutes
    // ago" without re-deriving it -- and so a stale response says HOW stale
    // rather than only that it is.
    age_ms: newestRow ? readingAgeMs(newestRow, nowMs) : null,
    change_usd: changeUsd,
    // Undefined from a zero base: a rise from 0 is not "infinitely more
    // expensive", it is a change with no meaningful ratio.
    change_pct:
      changeUsd === null || oldest === null || oldest === 0
        ? null
        : round9(changeUsd / oldest),
    // OMITTED, not emptied, when the caller opts out (#9720). An empty array
    // would be indistinguishable from a window that priced nothing, and the
    // counts above already say how many points exist -- so absence is the only
    // honest way to say "you asked not to be sent these". Every summary field
    // above is computed over the FULL series either way: narrowing the response
    // must not narrow the measurement.
    ...(includePoints ? { points } : {}),
  };
}

/**
 * The newest reading with its derivation attached.
 *
 * `pools` is served only here rather than on every point: it is the audit trail
 * for the current number, and repeating it across 2,000 points would multiply
 * the body for data that only answers "how was THIS price reached".
 */
function latestReading(row: Row): Row {
  return {
    usd_per_tao: positiveOrNull(row?.usd_per_tao),
    // Stated even when the price is null -- it is what says WHY it is null.
    price_basis: typeof row?.price_basis === "string" ? row.price_basis : null,
    eth_usd: positiveOrNull(row?.eth_usd),
    block_number: intOrNull(row?.block_number),
    observed_at: toIsoOrNull(row?.observed_at),
    pool_count: nonNegativeIntOrNull(row?.pool_count),
    pools: parsePools(row?.pools),
  };
}

/**
 * The per-pool breakdown, or an empty list.
 *
 * Stored as TEXT the producer serialized, so a parse failure is possible and
 * must not take the price down with it: the scalar is useful without the
 * breakdown, and the reverse is not true.
 */
function parsePools(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Finite and > 0, else null. A zero or negative USD price is a broken read --
 * and null already carries the meaning "could not be priced". */
function positiveOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function nonNegativeIntOrNull(value: unknown): number | null {
  const n = intOrNull(value);
  return n === null || n < 0 ? null : n;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * The current TAO/USD rate for pricing a TAO-denominated figure, or null.
 *
 * ONE IMPLEMENTATION, FOR EVERY SURFACE. REST had this as a private helper in
 * workers/request-handlers/entities.ts and MCP grew its own, which read a
 * DIFFERENT source: the `/metagraph/network/tao-usd.json` artifact rather than
 * the live index. That copy answered null in production while REST priced the
 * same subnet in the same second (measured 2026-08-12 on netuid 64: REST
 * `emission.usd` 86,917.23, MCP `emission.usd` null, "no TAO/USD rate") -- so
 * every USD leg on every MCP revenue and owner-cut response was null, and the
 * response said so in a way that reads as a stated outcome rather than a bug.
 *
 * The sibling MCP tool `get_tao_usd` was already reading the store correctly,
 * which is what makes this a copy problem rather than a missing capability:
 * the surface could always answer, and one hand-written mirror asked the wrong
 * thing.
 *
 * `taoUsdUsable` grades the reading rather than this function re-deriving the
 * bound: an unpriced reading (`insufficient_pools`), one past
 * TAO_USD_MAX_AGE_MS, and an empty table are three distinct outcomes that all
 * correctly converge on "no rate" -- and none of them is a rate of zero.
 */
export async function usdPerTaoOrNull(
  store: Parameters<typeof loadLatestTaoUsdReading>[0],
  nowMs: number = Date.now(),
): Promise<number | null> {
  const reading = await loadLatestTaoUsdReading(store);
  // Not `reading?.usd_per_tao ?? null` behind the grade: `taoUsdUsable` only
  // returns ok for a non-null, finite, positive rate, so that `??` arm is
  // unreachable -- and an unreachable branch reads as a tested one.
  if (!reading || !taoUsdUsable(reading, nowMs).ok) return null;
  return reading.usd_per_tao;
}
