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
// was not met, and migrations/d1/0004_user_state.sql enforces that pairing as a
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

type Row = Record<string, unknown>;

/** The minimal D1 surface used here, so tests can inject a plain object. */
export interface TaoUsdSeriesDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
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
  if (!db?.prepare) return null;
  try {
    const cutoff = now() - windowHours * 60 * 60 * 1000;
    const res = await (
      db
        .prepare(
          `SELECT block_number, observed_at, usd_per_tao, price_basis,` +
            ` eth_usd, pool_count, pools FROM ${TAO_USD_TABLE}` +
            ` WHERE observed_at >= ?` +
            ` ORDER BY observed_at DESC LIMIT ${TAO_USD_MAX_POINTS}`,
        )
        .bind(cutoff) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
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
  }: { window?: unknown; includePoints?: boolean } = {},
): Row {
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
      : round(newest - oldest);

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
    change_usd: changeUsd,
    // Undefined from a zero base: a rise from 0 is not "infinitely more
    // expensive", it is a change with no meaningful ratio.
    change_pct:
      changeUsd === null || oldest === null || oldest === 0
        ? null
        : round(changeUsd / oldest),
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

function round(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
