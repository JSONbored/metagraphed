// The TAO/USD index fails loudly, or it fails silently (#8603).
//
// Every other number this API serves is chain-derived and self-evidently
// reproducible: a wrong one is a bug, and it looks like one. A wrong PRICE is
// OUR wrong price, and it can be wrong while looking perfectly healthy -- a
// pool quietly returning stale reserves produces a plausible number with no
// error anywhere. That is the failure that actually happens, and it is now
// load-bearing: #10381/#10382/#10383 price every alpha figure we publish off
// this index, so a bad reading is not one card, it is the dollar axis of the
// whole surface.
//
// ## WHAT THE MEASUREMENTS SAY, AND WHY THE THRESHOLDS ARE WHERE THEY ARE
//
// Measured against production over the index's whole life (11,772 ticks,
// 2026-08-02 onward):
//
//   pool_count            2 on every tick -- min 2, max 2, never 3
//   price_basis           wrapped_onchain_median on every tick, never degraded
//   inter-pool spread     min 0.001%, avg 0.370%, p99 0.821%, max 0.862%
//
// Two facts follow, and they are the reason this module exists rather than a
// generic staleness check:
//
// THE INDEX HAS NEVER HAD A SPARE POOL. `MIN_QUALIFYING_POOLS` is 2 and
// `pool_count` has been exactly 2 for its entire life, so the redundancy margin
// is zero: one pool dropping out takes the index straight to
// `insufficient_pools`. That is a standing property of the on-chain liquidity,
// not an incident, which is why it is REPORTED on every verdict rather than
// alerted on every minute -- an alarm that is always firing is an alarm nobody
// reads. The runbook carries it; see docs/tao-usd-index-runbook.md.
//
// WITH EXACTLY TWO POOLS, OUTLIER REJECTION CANNOT REJECT AN OUTLIER -- IT
// COLLAPSES THE INDEX. `computeTaoUsdIndex` locates outliers against the
// UNWEIGHTED median, and the median of two values is their midpoint, so both
// pools are always equidistant from it by exactly half their spread. When that
// half-spread crosses `OUTLIER_THRESHOLD`, BOTH pools are rejected at once,
// survivors drop to zero, and ADR 0025 forbids falling back to the pre-
// rejection set. So a spread wider than 2 x OUTLIER_THRESHOLD (4%) does not
// discard the bad pool -- it stops publication entirely.
//
// The observed maximum half-spread is 0.431%. Warning at half the rejection
// threshold puts the alarm at 1% -- about 2.3x the worst thing that has ever
// happened, and half the distance to a total stop. That is the whole point of
// warning on DEVIATION rather than on the outcome: by the time `price_basis`
// reads `insufficient_pools` the index is already down.

import {
  MIN_QUALIFYING_POOLS,
  OUTLIER_THRESHOLD,
  type ExclusionReason,
} from "./tao-usd-index.ts";
import { TAO_USD_TABLE } from "./tao-usd-series.ts";
import { TAO_USD_TABLES } from "./read-store-tables.ts";
import { readStore } from "./read-store.ts";
import { recordLaneVerdict } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";

/** The lane name this watchdog records under. */
export const TAO_USD_WATCHDOG_LANE = "watchdog:tao-usd-index";

/** The minimal store surface, so tests can inject a plain object. */
export interface TaoUsdWatchdogDb {
  query?<Row>(text: string, values?: unknown[]): Promise<Row[]>;
}

type Row = Record<string, unknown>;

/**
 * How far a pool may drift from the reference before this warns.
 *
 * HALF the threshold that rejects it, derived rather than typed as a literal:
 * if ADR 0025 ever retunes OUTLIER_THRESHOLD, the warning moves with it
 * instead of silently becoming either noise or a rubber stamp.
 */
export const POOL_DEVIATION_WARN = OUTLIER_THRESHOLD / 2;

/**
 * How long a pool may be absent or excluded before it is called failing.
 *
 * The producer writes about once a minute, so this is ~15 ticks -- long enough
 * that one bad read, one reorg, or one RPC hiccup does not page anybody, short
 * enough that a genuinely dead pool is known about within a quarter hour. Sized
 * against the PRODUCER's cadence, not against a round number.
 */
export const POOL_FAILING_MS = 15 * 60 * 1000;

/** How much history each evaluation considers. 60 ticks at one per minute. */
export const TAO_USD_WATCHDOG_WINDOW_MS = 60 * 60 * 1000;

/** One pool's standing across the window. */
export interface PoolHealth {
  address: string;
  /** Ticks in the window where this pool contributed to the price. */
  includedTicks: number;
  /** Ticks where it was read or attempted but not counted. */
  excludedTicks: number;
  /** Newest observed_at where it contributed, or null if never. */
  lastIncludedAt: number | null;
  /** Why it was last excluded, when it was. */
  lastReason: ExclusionReason | string | null;
  /** Excluded/absent for longer than POOL_FAILING_MS. */
  failing: boolean;
}

export interface TaoUsdIndexVerdict {
  verdict: "ok" | "warn" | "fail";
  ticks: number;
  /** Ticks that published no price at all. */
  degradedTicks: number;
  /** Widest half-spread seen in the window, as a fraction. Null with <2 pools. */
  maxDeviation: number | null;
  /**
   * True when the index ran the whole window at exactly the quorum floor.
   *
   * Reported, never alerted: this has been true 100% of the time since the
   * lane started, so an alert would be a permanent alarm. It is the single
   * most important thing about this index's fragility, and it belongs in the
   * runbook and on the verdict -- not in a pager loop.
   */
  noRedundancy: boolean;
  pools: PoolHealth[];
  /** Human-readable, one per condition. Empty means healthy. */
  alerts: string[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The stored `pools` column is TEXT holding JSON; tolerate either form. */
function parsePools(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Row[]) : [];
  } catch {
    return [];
  }
}

/**
 * The widest distance any pool sat from the unweighted median, as a fraction.
 *
 * Computed the SAME way computeTaoUsdIndex locates outliers -- against the
 * unweighted median of the included readings -- so the number this warns on is
 * the number that will eventually reject them. Deriving it differently would
 * produce a warning that fires at a threshold the aggregator does not use.
 */
export function poolDeviation(pools: Row[]): number | null {
  const priced = pools
    .filter((p) => p?.included === true)
    .map((p) => num(p?.eth_per_tao))
    .filter((n): n is number => n !== null && n > 0);
  if (priced.length < 2) return null;
  // `priced` is already filtered to finite positives, so the median of it is
  // positive too -- no zero-reference guard here, because it could never be
  // taken and an untestable branch reads like a safeguard without being one.
  const sorted = [...priced].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const reference =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.max(...priced.map((p) => Math.abs(p - reference) / reference));
}

/**
 * Evaluate a window of stored index rows.
 *
 * Pure: the same rows always produce the same verdict, so the alert conditions
 * can be exercised without a database, an RPC, or a clock.
 *
 * `rows` may arrive in any order -- newest-first is what the loader returns,
 * but nothing here depends on it.
 */
export function evaluateTaoUsdIndex({
  rows,
  nowMs,
}: {
  rows: Row[] | null | undefined;
  nowMs: number;
}): TaoUsdIndexVerdict {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (r) => num(r?.observed_at) !== null,
  );
  const base: TaoUsdIndexVerdict = {
    verdict: "ok",
    ticks: list.length,
    degradedTicks: 0,
    maxDeviation: null,
    noRedundancy: false,
    pools: [],
    alerts: [],
  };

  // NO ROWS IS NOT HEALTHY. An empty window means the lane wrote nothing for an
  // hour, which is the wholly-failed-ingestion case -- distinct from individual
  // pool failures, and the one a per-pool check would report as "all quiet".
  if (list.length === 0) {
    return {
      ...base,
      verdict: "fail",
      alerts: [
        "tao_usd_index wrote no rows in the last hour: the ingestion lane is down, not merely degraded.",
      ],
    };
  }

  const alerts: string[] = [];
  let degradedTicks = 0;
  let maxDeviation: number | null = null;
  let everAboveFloor = false;

  const poolState = new Map<string, PoolHealth>();
  const touch = (address: string): PoolHealth => {
    let p = poolState.get(address);
    if (!p) {
      p = {
        address,
        includedTicks: 0,
        excludedTicks: 0,
        lastIncludedAt: null,
        lastReason: null,
        failing: false,
      };
      poolState.set(address, p);
    }
    return p;
  };

  for (const row of list) {
    const observedAt = num(row?.observed_at) as number;
    const poolCount = num(row?.pool_count) ?? 0;
    if (poolCount > MIN_QUALIFYING_POOLS) everAboveFloor = true;
    if (row?.price_basis === "insufficient_pools" || row?.usd_per_tao == null) {
      degradedTicks += 1;
    }

    const pools = parsePools(row?.pools);
    const deviation = poolDeviation(pools);
    if (deviation !== null)
      maxDeviation =
        maxDeviation === null ? deviation : Math.max(maxDeviation, deviation);

    for (const pool of pools) {
      const address = typeof pool?.address === "string" ? pool.address : null;
      if (address === null) continue;
      const p = touch(address);
      if (pool?.included === true) {
        p.includedTicks += 1;
        if (p.lastIncludedAt === null || observedAt > p.lastIncludedAt) {
          p.lastIncludedAt = observedAt;
        }
      } else {
        p.excludedTicks += 1;
        p.lastReason = (pool?.reason as string | undefined) ?? p.lastReason;
      }
    }
  }

  // A pool is failing when it has not contributed inside POOL_FAILING_MS --
  // measured against its LAST CONTRIBUTION, not against how many times it was
  // excluded, so a pool flapping in and out is not called dead while it is
  // still doing its job some of the time.
  for (const p of poolState.values()) {
    p.failing =
      p.lastIncludedAt === null || nowMs - p.lastIncludedAt > POOL_FAILING_MS;
  }
  const pools = [...poolState.values()].sort((a, b) =>
    a.address.localeCompare(b.address),
  );

  // Requirement 3: the degraded state is USER-VISIBLE through the published
  // contract, so it must never be discovered by a reader first. One tick is
  // enough -- this is not a flapping metric, it is "we published nothing".
  if (degradedTicks > 0) {
    alerts.push(
      `tao_usd_index published no price on ${degradedTicks} of ${list.length} ticks in the last hour (price_basis: insufficient_pools). Every USD figure the API serves is unavailable for those ticks.`,
    );
  }

  // Requirement 2: a persistently diverging pool means either that pool is
  // broken or our reading of it is, and both need a human. Warned on DEVIATION
  // rather than on the rejection it eventually causes, because with the
  // observed two-pool set the rejection is not a rejection -- it is a stop.
  if (maxDeviation !== null && maxDeviation >= POOL_DEVIATION_WARN) {
    alerts.push(
      `tao_usd_index pool deviation reached ${(maxDeviation * 100).toFixed(3)}% (warn ${(POOL_DEVIATION_WARN * 100).toFixed(2)}%, rejection ${(OUTLIER_THRESHOLD * 100).toFixed(2)}%). With ${MIN_QUALIFYING_POOLS} qualifying pools, crossing the rejection threshold removes BOTH and stops publication rather than discarding one.`,
    );
  }

  // Requirement 1: per-pool health, by last success rather than by rate.
  for (const p of pools.filter((x) => x.failing)) {
    alerts.push(
      p.lastIncludedAt === null
        ? `tao_usd_index pool ${p.address} contributed to no tick in the window (last reason: ${p.lastReason ?? "unstated"}).`
        : `tao_usd_index pool ${p.address} last contributed ${Math.round((nowMs - p.lastIncludedAt) / 60000)} minutes ago (last reason: ${p.lastReason ?? "unstated"}).`,
    );
  }

  // A degraded index or a dead pool is a failure; a widening spread is a
  // warning, because nothing is wrong with what we published yet.
  const failing = degradedTicks > 0 || pools.some((p) => p.failing);
  return {
    ...base,
    verdict: failing ? "fail" : alerts.length > 0 ? "warn" : "ok",
    degradedTicks,
    maxDeviation,
    noRedundancy: !everAboveFloor,
    pools,
    alerts,
  };
}

/**
 * Load the recent window and record a verdict.
 *
 * Runs on the freshness cron rather than on its own: `tao_usd_index`'s
 * staleness is already checked there, and the store is already reachable.
 *
 * This previously also cited a manual `wrangler triggers deploy` as a reason.
 * Measured 2026-08-15, that is false for this Worker -- #11362's new schedule
 * was created two seconds after the merge deployed, with no manual step (see
 * workers/config.ts's LANE_HEARTBEAT_EXTRA_CRON note). What still argues
 * against a dedicated cron is the grid: only three every-hour minutes were
 * free, and a watchdog that shares a tick with the thing it watches costs none
 * of them.
 */
export async function runTaoUsdIndexWatchdog(
  env: unknown,
  deps: {
    db?: TaoUsdWatchdogDb | null;
    laneHealthDb?: Parameters<typeof recordLaneVerdict>[0];
    now?: () => number;
  } = {},
): Promise<TaoUsdIndexVerdict & { recorded: boolean }> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const db =
    deps.db ?? (readStore(env, TAO_USD_TABLES) as unknown as TaoUsdWatchdogDb);

  let rows: Row[] | null;
  try {
    rows = db?.query
      ? ((await db.query<Row>(
          `SELECT observed_at, price_basis, usd_per_tao, pool_count, pools` +
            ` FROM ${TAO_USD_TABLE} WHERE observed_at >= ?` +
            ` ORDER BY observed_at DESC LIMIT 240`,
          [nowMs - TAO_USD_WATCHDOG_WINDOW_MS],
        )) as Row[])
      : null;
  } catch {
    // A read failure is NOT an empty window: reporting "the lane wrote nothing"
    // when we could not ask would send someone to the producer for a fault in
    // the reader. Null is passed through as its own condition below.
    rows = null;
  }

  const verdict =
    rows === null
      ? {
          ...evaluateTaoUsdIndex({ rows: [], nowMs }),
          alerts: [
            "tao_usd_index could not be read: the watchdog cannot say whether the index is healthy. This is a reader fault, not a producer verdict.",
          ],
        }
      : evaluateTaoUsdIndex({ rows, nowMs });

  // lane_health's vocabulary is "ok" | "stale" | "unknown" -- staleness-shaped,
  // because that is what every other lane reports. It cannot say "publishing,
  // but the pools are diverging". Rather than flatten that away silently, the
  // precise verdict rides in `detail` and the lane column carries the closest
  // honest value: `unknown` when we could not read (which is exactly what the
  // word means), `stale` for anything wrong, `ok` for healthy.
  const laneVerdict: "ok" | "stale" | "unknown" =
    rows === null ? "unknown" : verdict.verdict === "ok" ? "ok" : "stale";

  const recorded = await recordLaneVerdict(
    deps.laneHealthDb ?? laneHealthStore(env ?? {}),
    {
      lane: TAO_USD_WATCHDOG_LANE,
      verdict: laneVerdict,
      age_ms: null,
      detail: JSON.stringify({
        // The four-state verdict this watchdog actually computes, preserved
        // because the lane column above can only hold three.
        verdict: verdict.verdict,
        ticks: verdict.ticks,
        degraded_ticks: verdict.degradedTicks,
        max_deviation: verdict.maxDeviation,
        no_redundancy: verdict.noRedundancy,
        pools: verdict.pools.map((p) => ({
          address: p.address,
          included_ticks: p.includedTicks,
          excluded_ticks: p.excludedTicks,
          failing: p.failing,
        })),
        alerts: verdict.alerts,
      }),
      checked_at: nowMs,
    },
  );

  return { ...verdict, recorded };
}
