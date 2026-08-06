// GET /api/v1/chain/indexer-lag (#9620): how long after a block is produced it
// becomes queryable here.
//
// `chain_detail_blocks` has carried two clocks since 0010 -- `observed_at`, the
// chain's own timestamp as the firehose poller read it, and `synced_at`, the
// wall clock of the sync handler that wrote the row. Their difference is the
// end-to-end age of a block at the moment it became answerable, and nothing in
// the repo has ever selected `synced_at`: src/chain-detail-d1-write.ts binds it
// on every write and no route, watchdog or artifact reads it back.
//
// That difference is the only thing here that can answer "how long after a
// block happens can I query it?", which is the headline latency question for an
// API over a chain. Measured 2026-08-05 over 1,866 retained blocks: p50 34.1s,
// p95 43.6s, p99 57.6s, max 102.7s.
//
// ## TWO DIFFERENT NUMBERS, NAMED SEPARATELY
//
// `synced_at - observed_at` is how long THAT block took to land. How far behind
// the lane is RIGHT NOW is `now - MAX(observed_at)`, which is what
// CHAIN_DETAIL_STALENESS_THRESHOLD_MS alarms on. They answer different
// questions and diverge exactly when it matters: a stalled lane keeps a
// perfect write-latency distribution -- every block it did write, it wrote
// promptly -- while its head age climbs without bound. Serving either under the
// other's name would report a dead lane as healthy, so both are published and
// each is named for what it measures.
//
// ## THE WINDOW IS PUBLISHED BECAUSE THE TABLE IS PRUNED
//
// chain-detail-prune keeps a rolling window -- 1,862 contiguous blocks, about
// 6.2 hours, measured the same day. This is therefore the RECENT latency
// distribution and not a lifetime one, and the block range and timestamp bounds
// ride on the payload so a caller can see what was actually measured rather
// than inferring a history the table does not keep.
//
// ## A NEGATIVE LAG IS PUBLISHED, NOT CLAMPED
//
// The two timestamps come from two clocks: `observed_at` is the block author's
// and `synced_at` is Cloudflare's. Under author clock skew a block can appear
// to be written before it was produced. Clamping that to zero would suppress
// the single clearest piece of evidence that the skew exists, on the one route
// whose entire subject is the difference between those clocks -- so a negative
// value is served as measured.

type Row = Record<string, unknown>;

/** The minimal D1 surface used here, so tests can inject a plain object. */
export interface IndexerLagDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first?(): Promise<unknown>;
    };
  };
}

export const INDEXER_LAG_TABLE = "chain_detail_blocks";

/**
 * The whole card in one statement.
 *
 * Percentiles come from a ROW_NUMBER window rather than a sort-and-offset per
 * quantile: three `LIMIT 1 OFFSET n` subqueries would scan the table three more
 * times for numbers that all fall out of a single ranking. `MAX(CASE WHEN rn <=
 * k THEN l END)` is the value at rank k -- the largest lag among the k smallest,
 * which is the nearest-rank definition.
 *
 * The `(n * 95 + 99) / 100` form is integer arithmetic that rounds UP, so p95
 * on a short window names a real row rather than truncating toward p94. On a
 * single-row window every quantile is that row, which is correct.
 */
export const INDEXER_LAG_SQL =
  "WITH lag AS (" +
  `SELECT synced_at - observed_at AS l FROM ${INDEXER_LAG_TABLE}` +
  "), ranked AS (" +
  "SELECT l, ROW_NUMBER() OVER (ORDER BY l) AS rn, COUNT(*) OVER () AS n" +
  " FROM lag" +
  ") SELECT n AS block_count," +
  " MIN(l) AS min_ms, MAX(l) AS max_ms, AVG(l) AS mean_ms," +
  " MAX(CASE WHEN rn <= (n + 1) / 2 THEN l END) AS p50_ms," +
  " MAX(CASE WHEN rn <= (n * 95 + 99) / 100 THEN l END) AS p95_ms," +
  " MAX(CASE WHEN rn <= (n * 99 + 99) / 100 THEN l END) AS p99_ms," +
  ` (SELECT MIN(block_number) FROM ${INDEXER_LAG_TABLE}) AS oldest_block,` +
  ` (SELECT MAX(block_number) FROM ${INDEXER_LAG_TABLE}) AS newest_block,` +
  ` (SELECT MIN(observed_at) FROM ${INDEXER_LAG_TABLE}) AS oldest_observed_at,` +
  ` (SELECT MAX(observed_at) FROM ${INDEXER_LAG_TABLE}) AS newest_observed_at` +
  " FROM ranked GROUP BY n";

/** One aggregate row, or null when the read fails or the table is empty. */
export async function loadIndexerLag(
  db: IndexerLagDb | null | undefined,
): Promise<Row | null> {
  if (!db?.prepare) return null;
  try {
    const row = await (
      db.prepare(INDEXER_LAG_SQL).bind() as {
        first?(): Promise<unknown>;
      }
    ).first?.();
    return isRow(row) ? row : null;
  } catch {
    return null;
  }
}

/**
 * Shape the card. Pure apart from the clock, which is injected -- the same
 * reason parseChainDetailSync takes `syncedAt` rather than calling Date.now():
 * a module whose whole subject is two clocks should not quietly introduce a
 * third of its own.
 *
 * DECLINES rather than answering when the window is empty. An empty
 * `chain_detail_blocks` means the prune ran with no live-follow lane behind it,
 * which is a dead pipeline -- and a zero-millisecond lag is the single most
 * flattering thing this route could say about one. `degraded.reason` plus null
 * measurements, never a confident zero.
 */
export function buildIndexerLag(
  row: Row | null | undefined,
  nowMs: number,
): Row {
  const blockCount = intOrNull(row?.block_count);
  if (!row || blockCount === null || blockCount <= 0) {
    return {
      schema_version: 1,
      degraded: {
        reason: "no_retained_blocks",
        detail:
          "chain_detail_blocks holds no rows, so there is no block whose write " +
          "latency could be measured. Nothing is inferred about the lane's " +
          "speed from its silence.",
      },
      block_count: null,
      window: null,
      write_latency_ms: null,
      head_age_ms: null,
      measured_at: new Date(nowMs).toISOString(),
    };
  }

  const newestObserved = intOrNull(row.newest_observed_at);

  return {
    schema_version: 1,
    block_count: blockCount,
    // What was actually measured. The table is pruned on a rolling window, so
    // a distribution without its bounds would read as a lifetime one.
    window: {
      oldest_block: intOrNull(row.oldest_block),
      newest_block: intOrNull(row.newest_block),
      oldest_observed_at: toIsoOrNull(row.oldest_observed_at),
      newest_observed_at: toIsoOrNull(newestObserved),
    },
    // How long each block took to become queryable, in ms. Nearest-rank
    // percentiles over the retained window.
    write_latency_ms: {
      min: numberOrNull(row.min_ms),
      p50: numberOrNull(row.p50_ms),
      p95: numberOrNull(row.p95_ms),
      p99: numberOrNull(row.p99_ms),
      max: numberOrNull(row.max_ms),
      mean: roundOrNull(row.mean_ms),
    },
    // How far behind the lane is NOW -- a different question from the
    // distribution above, and the one that moves when the lane stalls. Null
    // rather than zero when the newest block carries no readable timestamp,
    // because zero would assert the lane is exactly current.
    head_age_ms: newestObserved === null ? null : nowMs - newestObserved,
    measured_at: new Date(nowMs).toISOString(),
  };
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}

/**
 * A finite number, or null.
 *
 * Deliberately NOT clamped at zero -- see the module header. A negative lag is
 * evidence of clock skew between the block author and our writer, and this is
 * the one route where that evidence belongs.
 */
function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The mean is the only non-integer here; a full float64 of millisecond
 * averages publishes precision the two source clocks do not have. */
function roundOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n);
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
