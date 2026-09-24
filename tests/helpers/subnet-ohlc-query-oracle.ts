// Frozen pre-retirement query oracle from 8e2cdd9b. This test-only code
// runs against SQLite, independently of native tree selection and folding.
import { hasRetainedHistoryStore } from "../../src/retained-history-store.ts";
import {
  buildSubnetOhlcFromBuckets,
  MAX_CANDLES,
  MAX_OHLC_WINDOW_DAYS,
  OHLC_INTERVALS,
  type OhlcBucket,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "../../src/subnet-ohlc.ts";
import { safeBlockNumber } from "../../src/history-readers.ts";
import type { HistoricalQueryReader } from "../../src/history-readers.ts";
import type { HistoryReadEnv } from "../../src/history-readers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface SubnetOhlcQuery {
  interval?: unknown;

  days?: unknown;

  limit?: number;
}

export type SubnetOhlcColdTierResult =
  | {
      kind: "answer";
      data: Record<string, unknown>;
      generatedAt: string | null;
    }
  | { kind: "gap" }
  | { kind: "miss" };

export async function loadSubnetOhlcColdTier(
  env: HistoryReadEnv | null | undefined,
  netuid: unknown,
  query: SubnetOhlcQuery = {},
  queryFn: HistoricalQueryReader,
): Promise<SubnetOhlcColdTierResult> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null || subnet === 0) return { kind: "miss" };

  const interval = query.interval ?? null;
  if (
    typeof interval !== "string" ||
    !Object.hasOwn(OHLC_INTERVALS, interval)
  ) {
    return { kind: "miss" };
  }
  const intervalMs = OHLC_INTERVALS[interval];

  const days = safeBlockNumber(query.days);
  if (days === null || days < 1 || days > MAX_OHLC_WINDOW_DAYS) {
    return { kind: "miss" };
  }
  const cutoff = Date.now() - days * DAY_MS;
  const bucketExpr = `CAST(FLOOR(observed_at / ${intervalMs}) AS BIGINT) * ${intervalMs}`;
  const rows = await queryFn(
    env,
    `WITH trades AS (` +
      `SELECT ${bucketExpr} AS bucket_start, observed_at, block_number, ` +
      `event_index, amount_tao / alpha_amount AS price, alpha_amount, amount_tao ` +
      `FROM chain.account_events ` +
      `WHERE netuid = ${subnet} ` +
      `AND (event_kind = '${STAKE_ADDED_KIND}' OR event_kind = '${STAKE_REMOVED_KIND}') ` +
      `AND observed_at >= ${cutoff} ` +
      `AND alpha_amount > 0 AND amount_tao IS NOT NULL` +
      `), ordered AS (` +
      `SELECT bucket_start, observed_at, price, alpha_amount, amount_tao, ` +
      `ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY observed_at ASC, ` +
      `block_number ASC, event_index ASC) AS seq_first, ` +
      `ROW_NUMBER() OVER (PARTITION BY bucket_start ORDER BY observed_at DESC, ` +
      `block_number DESC, event_index DESC) AS seq_last ` +
      `FROM trades` +
      `) SELECT bucket_start, ` +
      `MAX(CASE WHEN seq_first = 1 THEN price END) AS open_price, ` +
      `MAX(CASE WHEN seq_last = 1 THEN price END) AS close_price, ` +
      `MAX(price) AS high_price, MIN(price) AS low_price, ` +
      `SUM(alpha_amount) AS volume_alpha, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
      `FROM ordered GROUP BY bucket_start ` +
      `ORDER BY bucket_start DESC LIMIT ${MAX_CANDLES + 1}`,
  );
  if (rows === null) {
    return hasRetainedHistoryStore(env) ? { kind: "gap" } : { kind: "miss" };
  }
  const windowTruncated = rows.length > MAX_CANDLES;
  const page = windowTruncated ? rows.slice(0, MAX_CANDLES) : rows;

  const buckets = new Map<number, OhlcBucket>();
  let latest: number | null = null;
  for (const row of page) {
    const bucketStart = finite(row.bucket_start);
    const open = finite(row.open_price);
    const close = finite(row.close_price);
    const high = finite(row.high_price);
    const low = finite(row.low_price);
    const volumeAlpha = finite(row.volume_alpha);
    const volumeTao = finite(row.volume_tao);
    const eventCount = finite(row.event_count);
    if (
      bucketStart === null ||
      open === null ||
      close === null ||
      high === null ||
      low === null ||
      volumeAlpha === null ||
      volumeTao === null ||
      eventCount === null
    ) {
      return { kind: "gap" };
    }
    buckets.set(bucketStart, {
      open,
      high,
      low,
      close,
      volumeAlpha,
      volumeTao,
      eventCount,
    });
    const observed = finite(row.last_observed);
    if (
      observed !== null &&
      observed > 0 &&
      (latest === null || observed > latest)
    ) {
      latest = observed;
    }
  }

  return {
    kind: "answer",
    data: buildSubnetOhlcFromBuckets(buckets, subnet, {
      interval,
      limit: query.limit,
      windowTruncated,
    }),
    generatedAt: latest === null ? null : new Date(latest).toISOString(),
  };
}
