// Scheduled projections over the chain lakehouse (#9146).
//
// WHY A CRON, NOT A ONE-SHOT ARTIFACT AND NOT A REQUEST-TIME READER. The
// windowed aggregate routes (chain/transfers, chain/stake-flow) anchor their
// windows to the current date, so a one-shot materialization — the
// top-holders answer, whose inputs are frozen — would rot within a day. And
// R2 SQL is a second-scale engine with no indexes (src/r2-sql.ts's measured
// characteristics), so recomputing a network-wide aggregate under a request
// is the hot-path misuse that module's header warns against. A cron is the
// remaining shape: each lane recomputes its artifact from the lakehouse on an
// interval, and the artifact readers (src/*-artifact.ts) serve R2 gets.
//
// FAILURE POSTURE. A failed compute must NEVER overwrite a good artifact:
// the runner writes only on a non-null body, so the reader keeps serving the
// previous tick's answer — stale by one interval at worst, which is strictly
// better than garbage or a schema-stable empty. Lane failures are isolated
// (one lane's throw never skips the next) and each failure records exactly
// one exception under `projection:<name>` so a silently dead lane is visible.

import { isR2SqlConfigured, r2SqlQuery } from "./r2-sql.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import {
  CHAIN_TRANSFER_LIMIT_MAX,
  CHAIN_TRANSFER_WINDOWS,
} from "./chain-transfers.ts";
import {
  CHAIN_STAKE_FLOW_WINDOWS,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "./chain-stake-flow.ts";
import { CHAIN_TRANSFERS_PROJECTION_KEY } from "./chain-transfers-artifact.ts";
import { CHAIN_STAKE_FLOW_PROJECTION_KEY } from "./chain-stake-flow-artifact.ts";
import { STAKE_FLOW_WINDOWS } from "./stake-flow.ts";
import { ANALYTICS_WINDOWS } from "../workers/config.ts";
import {
  CHAIN_STAKE_MOVES_WINDOWS,
  STAKE_MOVED_EVENT_KIND,
} from "./chain-stake-moves.ts";
import {
  CHAIN_STAKE_TRANSFERS_WINDOWS,
  STAKE_TRANSFERRED_EVENT_KIND,
} from "./chain-stake-transfers.ts";
import {
  CHAIN_TRANSFER_PAIR_LIMIT_MAX,
  CHAIN_TRANSFER_PAIR_WINDOWS,
} from "./chain-transfer-pairs.ts";
import {
  CHAIN_ACTIVITY_PROJECTION_KEY,
  epochDayIso,
} from "./chain-activity-artifact.ts";
import {
  CHAIN_CALLS_LIMIT_MAX,
  CHAIN_CALLS_PROJECTION_KEY,
} from "./chain-calls-artifact.ts";
import {
  CHAIN_FEES_LIMIT_MAX,
  CHAIN_FEES_PROJECTION_KEY,
} from "./chain-fees-artifact.ts";
import {
  CHAIN_SIGNERS_LIMIT_MAX,
  CHAIN_SIGNERS_PROJECTION_KEY,
} from "./chain-signers-artifact.ts";
import { CHAIN_ALPHA_VOLUME_PROJECTION_KEY } from "./chain-alpha-volume-artifact.ts";
import { CHAIN_STAKE_TRANSFERS_PROJECTION_KEY } from "./chain-stake-transfers-artifact.ts";
import { CHAIN_TRANSFER_PAIRS_PROJECTION_KEY } from "./chain-transfer-pairs-artifact.ts";
import { CHAIN_STAKE_MOVES_PROJECTION_KEY } from "./chain-stake-moves-artifact.ts";
import {
  BLOCKS_SUMMARY_READ_COLUMNS,
  BLOCKS_SUMMARY_SCAN_CAP,
  buildBlocksSummary,
} from "./blocks-summary.ts";
import { BLOCKS_SUMMARY_PROJECTION_KEY } from "./blocks-summary-artifact.ts";

/** Matches the analytics routes' day arithmetic (workers/data-api.ts's
 * ANALYTICS_DAY_MS) so a lane's cutoff is the same instant the live Postgres
 * tier would have computed for the same window label. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** src/chain-transfers.ts keeps TRANSFER_KIND private; inlined here the same
 * way workers/data-api.ts inlines it for the identical query. */
const TRANSFER_KIND = "Transfer";

export interface ProjectionLane {
  name: string;
  /** R2 key under metagraph/projections/ the runner writes and the matching
   * artifact reader gets — imported FROM the reader module so the writer and
   * reader cannot drift apart. */
  artifactKey: string;
  /** Reserved: a lane that needs its own cadence declares it and gets its own
   * dispatch branch. Every current lane runs on the shared
   * PROJECTION_LANES_CRON tick, so none sets this yet. */
  intervalCron?: string;
  /** The artifact body ({schema_version, generated_at, row_count, windows}),
   * or null when the lakehouse could not answer EVERY query — a partial
   * artifact would serve one window's fresh numbers next to another's
   * garbage, so all-or-nothing is the only honest contract. */
  compute(env: Env): Promise<Record<string, unknown> | null>;
}

/** Every value a lane inlines below is a module constant or a computed
 * integer — never caller input — per src/r2-sql.ts's no-bound-params
 * contract. */
function transferWindowSql(cutoff: number): string[] {
  const scope =
    `FROM chain.account_events ` +
    `WHERE event_kind = '${TRANSFER_KIND}' AND observed_at >= ${cutoff}`;
  // The same five statements workers/data-api.ts issues for this route, in
  // the same split: the two DISTINCT counts were separated there because each
  // one alone is the heaviest scan in the family, and the same
  // one-heavy-aggregation-per-statement shape keeps each query under R2 SQL's
  // own per-query ceiling here.
  return [
    `SELECT COUNT(*) AS transfer_count, ` +
      `COALESCE(SUM(amount_tao), 0) AS total_volume_tao, ` +
      `MAX(observed_at) AS newest_observed ${scope}`,
    `SELECT COUNT(DISTINCT hotkey) AS unique_senders ${scope}`,
    `SELECT COUNT(DISTINCT coldkey) AS unique_receivers ${scope}`,
    // Leaderboards are precomputed at the route's MAXIMUM limit so every
    // smaller ?limit= is a prefix slice of the same total order
    // (volume DESC, address ASC) — one artifact serves every limit, the way
    // one top-holders artifact serves every sort.
    `SELECT hotkey AS address, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS transfer_count ${scope} AND hotkey IS NOT NULL ` +
      `GROUP BY hotkey ORDER BY volume_tao DESC, hotkey ASC ` +
      `LIMIT ${CHAIN_TRANSFER_LIMIT_MAX}`,
    `SELECT coldkey AS address, SUM(amount_tao) AS volume_tao, ` +
      `COUNT(*) AS transfer_count ${scope} AND coldkey IS NOT NULL ` +
      `GROUP BY coldkey ORDER BY volume_tao DESC, coldkey ASC ` +
      `LIMIT ${CHAIN_TRANSFER_LIMIT_MAX}`,
  ];
}

/** GET /api/v1/chain/transfers, every supported window, from the lakehouse
 * account_events Transfer feed — the R2 SQL replication of data-api's route
 * queries, windows computed from this run's generated_at. */
async function computeChainTransfers(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_TRANSFER_WINDOWS)) {
    const [
      totalsSql,
      sendersCountSql,
      receiversCountSql,
      sendersSql,
      receiversSql,
    ] = transferWindowSql(generatedAt - days * DAY_MS);
    // Sequential on purpose: one second-scale scan in flight at a time, the
    // posture every cold-tier caller of r2SqlQuery takes.
    const totals = await r2SqlQuery(env, totalsSql!);
    if (totals === null) return null;
    const senderCount = await r2SqlQuery(env, sendersCountSql!);
    if (senderCount === null) return null;
    const receiverCount = await r2SqlQuery(env, receiversCountSql!);
    if (receiverCount === null) return null;
    const senders = await r2SqlQuery(env, sendersSql!);
    if (senders === null) return null;
    const receivers = await r2SqlQuery(env, receiversSql!);
    if (receivers === null) return null;
    windows[label] = {
      days,
      // The exact `totals` object data-api hands buildChainTransfers: the
      // single-row aggregate spread together with the two DISTINCT counts.
      totals: {
        ...(totals[0] ?? null),
        unique_senders: senderCount[0]?.unique_senders ?? 0,
        unique_receivers: receiverCount[0]?.unique_receivers ?? 0,
      },
      senders,
      receivers,
    };
    rowCount += senders.length + receivers.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/stake-flow, every supported window — data-api's single
 * GROUP BY netuid, event_kind aggregate in R2 SQL, rows stored verbatim so
 * the reader's buildChainStakeFlow pass serves every limit. */
/**
 * The windows this lane precomputes: the UNION of the chain-wide route's set
 * and the per-subnet route's, because both are served from this one artifact
 * (src/subnet-stake-flow-artifact.ts). The rows are grouped by
 * (netuid, event_kind) either way, so the per-subnet route costs no extra
 * query -- only the 90d window it accepts and the chain route does not.
 *
 * Each reader still gates on its OWN route's window set, so widening this does
 * not widen either route's accepted parameters.
 */
export const STAKE_FLOW_PROJECTION_WINDOWS: Record<string, number> = {
  ...CHAIN_STAKE_FLOW_WINDOWS,
  ...STAKE_FLOW_WINDOWS,
};

async function computeChainStakeFlow(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(STAKE_FLOW_PROJECTION_WINDOWS)) {
    const cutoff = generatedAt - days * DAY_MS;
    const rows = await r2SqlQuery(
      env,
      `SELECT netuid, event_kind, COALESCE(SUM(amount_tao), 0) AS total_tao, ` +
        `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
        `FROM chain.account_events ` +
        `WHERE event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}') ` +
        `AND observed_at >= ${cutoff} GROUP BY netuid, event_kind`,
    );
    if (rows === null) return null;
    windows[label] = { days, rows };
    rowCount += rows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** data-api renders its per-UTC-day buckets with
 * to_char(to_timestamp(observed_at / 1000), 'YYYY-MM-DD'); R2 SQL has no
 * proven date-render function, so the day lanes group by this integer UTC
 * epoch-day instead — exact for the non-negative epoch-ms observed_at values
 * the lakehouse holds (integer division truncates toward zero, which is floor
 * for non-negatives) — and epochDayIso renders the identical 'YYYY-MM-DD'
 * label writer-side. */
const EPOCH_DAY_EXPR = `observed_at / ${DAY_MS}`;

/** The unsigned-inherent filter data-api writes as
 * `COUNT(*) FILTER (WHERE signer IS NOT NULL)`: the FILTER clause is
 * unprobed in R2 SQL, and this CASE form is its textbook-equivalent
 * expansion, not an approximation. */
const SIGNED_COUNT_EXPR = "SUM(CASE WHEN signer IS NOT NULL THEN 1 ELSE 0 END)";

/** GET /api/v1/chain/activity's four statements for one window cutoff — the
 * same split data-api runs (base extrinsic aggregate, the per-day DISTINCT
 * signer count in its own statement, the blocks aggregate, and the blocks
 * freshness read), grouped by UTC epoch-day instead of a rendered string. */
function chainActivityWindowSql(cutoff: number): string[] {
  const extrinsics = `FROM chain.extrinsics WHERE observed_at >= ${cutoff}`;
  const blocks = `FROM chain.blocks WHERE observed_at >= ${cutoff}`;
  return [
    // `success = TRUE` (not the bare `success` data-api writes) is the
    // predicate form the extrinsics cold tier already issues against this
    // exact column — proven, and boolean-identical.
    `SELECT ${EPOCH_DAY_EXPR} AS day_index, COUNT(*) AS extrinsic_count, ` +
      `SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful_extrinsics ` +
      `${extrinsics} GROUP BY day_index`,
    `SELECT ${EPOCH_DAY_EXPR} AS day_index, ` +
      `COUNT(DISTINCT signer) AS unique_signers ` +
      `${extrinsics} GROUP BY day_index`,
    `SELECT ${EPOCH_DAY_EXPR} AS day_index, COUNT(*) AS block_count, ` +
      `SUM(event_count) AS event_count ${blocks} GROUP BY day_index`,
    `SELECT MAX(observed_at) AS newest_observed ${blocks}`,
  ];
}

/** Re-key one day-grouped result set from the integer epoch-day to data-api's
 * 'YYYY-MM-DD' `day` string, or null when a day index is unrenderable — a
 * malformed bucket must decline the whole compute, never mislabel a day. */
function withDayLabels(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] | null {
  const out: Record<string, unknown>[] = [];
  for (const { day_index: dayIndex, ...rest } of rows) {
    const day = epochDayIso(dayIndex);
    if (day === null) return null;
    out.push({ day, ...rest });
  }
  return out;
}

/** GET /api/v1/chain/activity, every supported window — data-api's per-UTC-day
 * extrinsics/blocks aggregates in R2 SQL, with the DISTINCT-signer counts
 * merged into the extrinsic rows exactly as that route merges them before
 * buildChainActivity. */
async function computeChainActivity(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
    const [baseSql, signersSql, blocksSql, freshSql] = chainActivityWindowSql(
      generatedAt - days * DAY_MS,
    );
    const base = await r2SqlQuery(env, baseSql!);
    if (base === null) return null;
    const signers = await r2SqlQuery(env, signersSql!);
    if (signers === null) return null;
    const blocks = await r2SqlQuery(env, blocksSql!);
    if (blocks === null) return null;
    const fresh = await r2SqlQuery(env, freshSql!);
    if (fresh === null) return null;
    const signersByDay = new Map(
      signers.map((row) => [String(row.day_index), row.unique_signers]),
    );
    const merged = base.map((row) => ({
      ...row,
      unique_signers: signersByDay.get(String(row.day_index)) ?? 0,
    }));
    const extrinsicRows = withDayLabels(merged);
    if (extrinsicRows === null) return null;
    const blockRows = withDayLabels(blocks);
    if (blockRows === null) return null;
    windows[label] = {
      days,
      extrinsic_rows: extrinsicRows,
      block_rows: blockRows,
      newest_observed: fresh[0]?.newest_observed ?? null,
    };
    rowCount += extrinsicRows.length + blockRows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/calls' statements for one window cutoff: freshness, the
 * grouped rows for BOTH group_by variants (each at the route's maximum limit
 * so every smaller ?limit= is a prefix slice of the same total order), and
 * the unfiltered full-window share denominator. The optional call_module
 * scope is NOT precomputed — its value space is unbounded, so the reader
 * declines filtered calls instead of approximating them. */
function chainCallsWindowSql(cutoff: number): string[] {
  const scope = `FROM chain.extrinsics WHERE observed_at >= ${cutoff}`;
  return [
    `SELECT MAX(observed_at) AS newest_observed ${scope}`,
    `SELECT call_module, COUNT(*) AS count ${scope} ` +
      `AND call_module IS NOT NULL GROUP BY call_module ` +
      `ORDER BY count DESC, call_module ASC LIMIT ${CHAIN_CALLS_LIMIT_MAX}`,
    `SELECT call_module, call_function, COUNT(*) AS count ${scope} ` +
      `AND call_module IS NOT NULL GROUP BY call_module, call_function ` +
      `ORDER BY count DESC, call_module ASC, call_function ASC ` +
      `LIMIT ${CHAIN_CALLS_LIMIT_MAX}`,
    `SELECT COUNT(*) AS total ${scope}`,
  ];
}

/** GET /api/v1/chain/calls, every supported window and both group_by
 * variants — data-api's call-mix breakdown with the share denominator read
 * separately, pre-LIMIT, exactly like the live tier. */
async function computeChainCalls(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
    const [freshSql, moduleSql, moduleFunctionSql, totalSql] =
      chainCallsWindowSql(generatedAt - days * DAY_MS);
    const fresh = await r2SqlQuery(env, freshSql!);
    if (fresh === null) return null;
    const moduleRows = await r2SqlQuery(env, moduleSql!);
    if (moduleRows === null) return null;
    const moduleFunctionRows = await r2SqlQuery(env, moduleFunctionSql!);
    if (moduleFunctionRows === null) return null;
    const total = await r2SqlQuery(env, totalSql!);
    if (total === null) return null;
    windows[label] = {
      days,
      newest_observed: fresh[0]?.newest_observed ?? null,
      total: total[0]?.total ?? 0,
      groups: {
        module: moduleRows,
        module_function: moduleFunctionRows,
      },
    };
    rowCount += moduleRows.length + moduleFunctionRows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** Postgres computes chain/fees' exact per-day medians with
 * PERCENTILE_CONT(0.5) WITHIN GROUP; R2 SQL has no proven ordered-set
 * aggregates, so this is the same statistic from probed primitives: rank the
 * non-NULL values per day (PERCENTILE_CONT ignores NULLs), keep the middle
 * one (odd count) or middle two (even count), and AVG them — which IS the
 * 0.5-quantile linear interpolation, not an approximation of it. */
function chainFeesMedianSql(cutoff: number, column: string): string {
  return (
    `WITH ranked AS (SELECT ${EPOCH_DAY_EXPR} AS day_index, ${column}, ` +
    `ROW_NUMBER() OVER (PARTITION BY ${EPOCH_DAY_EXPR} ORDER BY ${column}) AS rn, ` +
    `COUNT(*) OVER (PARTITION BY ${EPOCH_DAY_EXPR}) AS cnt ` +
    `FROM chain.extrinsics WHERE observed_at >= ${cutoff} ` +
    `AND signer IS NOT NULL AND ${column} IS NOT NULL) ` +
    `SELECT day_index, AVG(${column}) AS median_value FROM ranked ` +
    `WHERE rn * 2 = cnt OR rn * 2 = cnt + 1 OR rn * 2 = cnt + 2 ` +
    `GROUP BY day_index`
  );
}

/** GET /api/v1/chain/fees' non-median statements for one window cutoff. */
function chainFeesWindowSql(cutoff: number): string[] {
  const scope = `FROM chain.extrinsics WHERE observed_at >= ${cutoff}`;
  return [
    `SELECT ${EPOCH_DAY_EXPR} AS day_index, COUNT(*) AS extrinsic_count, ` +
      `${SIGNED_COUNT_EXPR} AS signed_extrinsic_count, ` +
      `SUM(COALESCE(fee_tao, 0)) AS total_fee_tao, ` +
      `SUM(COALESCE(tip_tao, 0)) AS total_tip_tao ` +
      `${scope} GROUP BY day_index`,
    `SELECT signer, SUM(COALESCE(fee_tao, 0)) AS total_fee_tao, ` +
      `SUM(COALESCE(tip_tao, 0)) AS total_tip_tao, ` +
      `COUNT(*) AS extrinsic_count ${scope} AND signer IS NOT NULL ` +
      `GROUP BY signer ORDER BY total_fee_tao DESC, signer ASC ` +
      `LIMIT ${CHAIN_FEES_LIMIT_MAX}`,
    `SELECT MAX(observed_at) AS newest_observed ${scope}`,
  ];
}

/** GET /api/v1/chain/fees, every supported window — the per-UTC-day fee/tip
 * series, the top-fee-payer leaderboard at the route's maximum limit, and the
 * exact per-day medians, merged into data-api's medianRows shape (a day
 * absent from a median column means every value was NULL, which is exactly
 * the NULL median PERCENTILE_CONT reports). The call_module scope is not
 * precomputed — the reader declines filtered calls. */
async function computeChainFees(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
    const cutoff = generatedAt - days * DAY_MS;
    const [dailySql, payersSql, freshSql] = chainFeesWindowSql(cutoff);
    const daily = await r2SqlQuery(env, dailySql!);
    if (daily === null) return null;
    const payers = await r2SqlQuery(env, payersSql!);
    if (payers === null) return null;
    const feeMedians = await r2SqlQuery(
      env,
      chainFeesMedianSql(cutoff, "fee_tao"),
    );
    if (feeMedians === null) return null;
    const tipMedians = await r2SqlQuery(
      env,
      chainFeesMedianSql(cutoff, "tip_tao"),
    );
    if (tipMedians === null) return null;
    const fresh = await r2SqlQuery(env, freshSql!);
    if (fresh === null) return null;
    const dailyRows = withDayLabels(daily);
    if (dailyRows === null) return null;
    // Merge the two per-column median passes into the one medianRows list
    // data-api hands buildChainFees ({day, median_fee_tao, median_tip_tao}).
    const medianByDay = new Map<
      string,
      { median_fee_tao?: unknown; median_tip_tao?: unknown }
    >();
    for (const row of feeMedians) {
      const day = epochDayIso(row.day_index);
      if (day === null) return null;
      medianByDay.set(day, { median_fee_tao: row.median_value });
    }
    for (const row of tipMedians) {
      const day = epochDayIso(row.day_index);
      if (day === null) return null;
      const entry = medianByDay.get(day) ?? {};
      entry.median_tip_tao = row.median_value;
      medianByDay.set(day, entry);
    }
    const medianRows = [...medianByDay.entries()].map(([day, medians]) => ({
      day,
      ...medians,
    }));
    windows[label] = {
      days,
      newest_observed: fresh[0]?.newest_observed ?? null,
      daily_rows: dailyRows,
      median_rows: medianRows,
      payer_rows: payers,
    };
    rowCount += dailyRows.length + payers.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/signers' statements for one window cutoff: the separate
 * freshness read data-api needs (grouped rows carry last_tx_block, not a
 * network observed_at), then the leaderboard in BOTH supported sort orders at
 * the route's maximum limit. call_module is not precomputed — the reader
 * declines filtered calls. */
function chainSignersWindowSql(cutoff: number): string[] {
  const scope = `FROM chain.extrinsics WHERE observed_at >= ${cutoff}`;
  const leaderboard = (orderBy: string) =>
    `SELECT signer, COUNT(*) AS tx_count, ` +
    `SUM(COALESCE(fee_tao, 0)) AS total_fee_tao, ` +
    `SUM(COALESCE(tip_tao, 0)) AS total_tip_tao, ` +
    `MAX(block_number) AS last_tx_block ${scope} AND signer IS NOT NULL ` +
    `GROUP BY signer ORDER BY ${orderBy} DESC, signer ASC ` +
    `LIMIT ${CHAIN_SIGNERS_LIMIT_MAX}`;
  return [
    `SELECT MAX(observed_at) AS newest_observed ${scope}`,
    leaderboard("tx_count"),
    leaderboard("total_fee_tao"),
  ];
}

/** GET /api/v1/chain/signers, every supported window and both sorts. */
async function computeChainSigners(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(ANALYTICS_WINDOWS)) {
    const [freshSql, txCountSql, feeSql] = chainSignersWindowSql(
      generatedAt - days * DAY_MS,
    );
    const fresh = await r2SqlQuery(env, freshSql!);
    if (fresh === null) return null;
    const txCountRows = await r2SqlQuery(env, txCountSql!);
    if (txCountRows === null) return null;
    const feeRows = await r2SqlQuery(env, feeSql!);
    if (feeRows === null) return null;
    windows[label] = {
      days,
      newest_observed: fresh[0]?.newest_observed ?? null,
      sorts: {
        tx_count: txCountRows,
        total_fee_tao: feeRows,
      },
    };
    rowCount += txCountRows.length + feeRows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/alpha-volume — data-api's single GROUP BY netuid,
 * event_kind aggregate over the route's fixed rolling 24h window, rows
 * stored verbatim for buildChainAlphaVolume (which owns ranking, the network
 * rollup, the distribution, and the limit slice). */
async function computeChainAlphaVolume(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const cutoff = generatedAt - DAY_MS;
  const rows = await r2SqlQuery(
    env,
    `SELECT netuid, event_kind, ` +
      `COALESCE(SUM(alpha_amount), 0) AS alpha_volume, ` +
      `COALESCE(SUM(amount_tao), 0) AS tao_volume, ` +
      `COUNT(*) AS event_count, MAX(observed_at) AS last_observed ` +
      `FROM chain.account_events ` +
      `WHERE event_kind IN ('${STAKE_ADDED_KIND}', '${STAKE_REMOVED_KIND}') ` +
      `AND observed_at >= ${cutoff} GROUP BY netuid, event_kind`,
  );
  if (rows === null) return null;
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rows.length,
    // The route has no ?window= param; the one fixed window keeps the same
    // envelope shape as every sibling artifact.
    windows: { "24h": { days: 1, rows } },
  };
}

/** The network-distinct + per-subnet statement pair shared by the
 * stake-transfers and stake-moves lanes (data-api's exact two statements for
 * each route — only the event kind and the count column names differ). */
function subnetDistinctWindowSql(
  cutoff: number,
  eventKind: string,
  countAlias: string,
  distinctAlias: string,
): { networkSql: string; subnetSql: string } {
  const scope =
    `FROM chain.account_events ` +
    `WHERE event_kind = '${eventKind}' AND observed_at >= ${cutoff}`;
  return {
    networkSql:
      `SELECT COUNT(DISTINCT coldkey) AS ${distinctAlias}, ` +
      `MAX(observed_at) AS newest_observed ${scope}`,
    subnetSql:
      `SELECT netuid, COUNT(*) AS ${countAlias}, ` +
      `COUNT(DISTINCT coldkey) AS ${distinctAlias} ${scope} ` +
      `GROUP BY netuid ORDER BY ${countAlias} DESC, netuid ASC`,
  };
}

/** One stake-transfers/stake-moves window: the network DISTINCT row, then —
 * only when the window observed anything, data-api's exact guard — the
 * per-subnet aggregate. Returns null on any query failure. */
async function computeSubnetDistinctWindow(
  env: Env,
  sql: { networkSql: string; subnetSql: string },
): Promise<{
  network: Record<string, unknown> | null;
  rows: Record<string, unknown>[];
} | null> {
  const networkRows = await r2SqlQuery(env, sql.networkSql);
  if (networkRows === null) return null;
  const network = networkRows[0] ?? null;
  let rows: Record<string, unknown>[] = [];
  if (network?.newest_observed != null) {
    const subnetRows = await r2SqlQuery(env, sql.subnetSql);
    if (subnetRows === null) return null;
    rows = subnetRows;
  }
  return { network, rows };
}

/** GET /api/v1/chain/stake-transfers, every supported window — the
 * network-wide distinct-sender row plus the per-subnet StakeTransferred
 * aggregate, stored verbatim for buildChainStakeTransfers. */
async function computeChainStakeTransfers(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_STAKE_TRANSFERS_WINDOWS)) {
    const window = await computeSubnetDistinctWindow(
      env,
      subnetDistinctWindowSql(
        generatedAt - days * DAY_MS,
        STAKE_TRANSFERRED_EVENT_KIND,
        "transfers",
        "distinct_senders",
      ),
    );
    if (window === null) return null;
    windows[label] = { days, network: window.network, rows: window.rows };
    rowCount += window.rows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/stake-moves, every supported window — same shape as the
 * stake-transfers lane over the StakeMoved stream. */
async function computeChainStakeMoves(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_STAKE_MOVES_WINDOWS)) {
    const window = await computeSubnetDistinctWindow(
      env,
      subnetDistinctWindowSql(
        generatedAt - days * DAY_MS,
        STAKE_MOVED_EVENT_KIND,
        "movements",
        "distinct_movers",
      ),
    );
    if (window === null) return null;
    windows[label] = { days, network: window.network, rows: window.rows };
    rowCount += window.rows.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/** GET /api/v1/chain/transfer-pairs' statements for one window cutoff:
 * data-api's CTE totals rollup, then the corridor leaderboard in BOTH
 * supported sort orders at the route's maximum limit. The PAIR_FILTER
 * predicate is inlined the same way data-api inlines it (it is private to
 * src/chain-transfer-pairs.ts). */
function chainTransferPairsWindowSql(cutoff: number): string[] {
  const scope =
    `FROM chain.account_events ` +
    `WHERE event_kind = '${TRANSFER_KIND}' AND observed_at >= ${cutoff} ` +
    `AND hotkey IS NOT NULL AND coldkey IS NOT NULL ` +
    `AND hotkey <> '' AND coldkey <> '' AND hotkey <> coldkey ` +
    `AND amount_tao IS NOT NULL AND amount_tao >= 0`;
  const leaderboard = (orderBy: string) =>
    `SELECT hotkey AS from_address, coldkey AS to_address, ` +
    `SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count, ` +
    `MAX(block_number) AS last_block, ` +
    `MAX(observed_at) AS last_observed_at ${scope} ` +
    `GROUP BY hotkey, coldkey ORDER BY ${orderBy} ` +
    `LIMIT ${CHAIN_TRANSFER_PAIR_LIMIT_MAX}`;
  return [
    `WITH pair_totals AS (SELECT hotkey, coldkey, ` +
      `SUM(amount_tao) AS volume_tao, COUNT(*) AS transfer_count, ` +
      `MAX(observed_at) AS last_observed ${scope} ` +
      `GROUP BY hotkey, coldkey) ` +
      `SELECT COALESCE(SUM(transfer_count), 0) AS transfer_count, ` +
      `COALESCE(SUM(volume_tao), 0) AS total_volume_tao, ` +
      `COUNT(*) AS unique_pairs, ` +
      `COALESCE(MAX(volume_tao), 0) AS top_pair_volume_tao, ` +
      `MAX(last_observed) AS newest_observed FROM pair_totals`,
    leaderboard(
      "volume_tao DESC, transfer_count DESC, hotkey ASC, coldkey ASC",
    ),
    leaderboard(
      "transfer_count DESC, volume_tao DESC, hotkey ASC, coldkey ASC",
    ),
  ];
}

/** GET /api/v1/chain/transfer-pairs, every supported window and both sorts. */
async function computeChainTransferPairs(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const windows: Record<string, unknown> = {};
  let rowCount = 0;
  for (const [label, days] of Object.entries(CHAIN_TRANSFER_PAIR_WINDOWS)) {
    const [totalsSql, volumeSql, countSql] = chainTransferPairsWindowSql(
      generatedAt - days * DAY_MS,
    );
    const totals = await r2SqlQuery(env, totalsSql!);
    if (totals === null) return null;
    const volumePairs = await r2SqlQuery(env, volumeSql!);
    if (volumePairs === null) return null;
    const countPairs = await r2SqlQuery(env, countSql!);
    if (countPairs === null) return null;
    windows[label] = {
      days,
      totals: totals[0] ?? null,
      sorts: { volume: volumePairs, count: countPairs },
    };
    rowCount += volumePairs.length + countPairs.length;
  }
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rowCount,
    windows,
  };
}

/**
 * GET /api/v1/blocks/summary's card, precomputed.
 *
 * Reads the newest BLOCKS_SUMMARY_SCAN_CAP blocks -- the same fixed recent
 * window loadBlocksSummary scanned in D1, and the same ORDER BY -- then shapes
 * them with the SAME buildBlocksSummary the Postgres tier fed. Storing the
 * shaped card rather than the rows is deliberate: the route takes no
 * parameters, so there is exactly one output shape and nothing for a reader to
 * re-slice.
 *
 * An empty lakehouse answer is NOT stored. buildBlocksSummary([]) is a zeroed
 * card, and writing that over a good artifact would replace real numbers with
 * a plausible-looking blank -- exactly the silent failure the all-or-nothing
 * contract exists to prevent. The caller already holds a zeroed card as its
 * floor; it does not need one persisted.
 */
async function computeBlocksSummary(
  env: Env,
): Promise<Record<string, unknown> | null> {
  const generatedAt = Date.now();
  const rows = await r2SqlQuery(
    env,
    `SELECT ${BLOCKS_SUMMARY_READ_COLUMNS} FROM chain.blocks ` +
      `ORDER BY block_number DESC LIMIT ${BLOCKS_SUMMARY_SCAN_CAP}`,
  );
  if (rows === null || rows.length === 0) return null;
  return {
    schema_version: 1,
    generated_at: new Date(generatedAt).toISOString(),
    row_count: rows.length,
    summary: buildBlocksSummary(rows),
  };
}

export const PROJECTION_LANES: ProjectionLane[] = [
  {
    name: "blocks-summary",
    artifactKey: BLOCKS_SUMMARY_PROJECTION_KEY,
    compute: computeBlocksSummary,
  },
  {
    name: "chain-transfers",
    artifactKey: CHAIN_TRANSFERS_PROJECTION_KEY,
    compute: computeChainTransfers,
  },
  {
    name: "chain-stake-flow",
    artifactKey: CHAIN_STAKE_FLOW_PROJECTION_KEY,
    compute: computeChainStakeFlow,
  },
  {
    name: "chain-activity",
    artifactKey: CHAIN_ACTIVITY_PROJECTION_KEY,
    compute: computeChainActivity,
  },
  {
    name: "chain-calls",
    artifactKey: CHAIN_CALLS_PROJECTION_KEY,
    compute: computeChainCalls,
  },
  {
    name: "chain-fees",
    artifactKey: CHAIN_FEES_PROJECTION_KEY,
    compute: computeChainFees,
  },
  {
    name: "chain-signers",
    artifactKey: CHAIN_SIGNERS_PROJECTION_KEY,
    compute: computeChainSigners,
  },
  {
    name: "chain-alpha-volume",
    artifactKey: CHAIN_ALPHA_VOLUME_PROJECTION_KEY,
    compute: computeChainAlphaVolume,
  },
  {
    name: "chain-stake-transfers",
    artifactKey: CHAIN_STAKE_TRANSFERS_PROJECTION_KEY,
    compute: computeChainStakeTransfers,
  },
  {
    name: "chain-transfer-pairs",
    artifactKey: CHAIN_TRANSFER_PAIRS_PROJECTION_KEY,
    compute: computeChainTransferPairs,
  },
  {
    name: "chain-stake-moves",
    artifactKey: CHAIN_STAKE_MOVES_PROJECTION_KEY,
    compute: computeChainStakeMoves,
  },
];

interface ProjectionBucket {
  put(key: string, value: string): Promise<unknown>;
}

export interface ProjectionLaneDeps {
  recordException?: typeof recordExceptionEvent;
}

export interface ProjectionLaneResult {
  name: string;
  ok: boolean;
  /** The written body's own row_count, or null when nothing was written. */
  rows: number | null;
  reason?: string;
}

/**
 * Run one lane: compute, and write the artifact ONLY on a non-null body. A
 * null compute (or a throwing store) leaves the previous artifact in place,
 * logs, and records one exception under `projection:<name>`.
 */
export async function runProjectionLane(
  env: Env,
  lane: ProjectionLane,
  deps: ProjectionLaneDeps = {},
): Promise<ProjectionLaneResult> {
  const record = deps.recordException ?? recordExceptionEvent;
  const bucket = (env as { METAGRAPH_ARCHIVE?: ProjectionBucket } | null)
    ?.METAGRAPH_ARCHIVE;
  if (!bucket?.put) {
    // Without the bucket a computed body has nowhere durable to land —
    // refuse before spending second-scale queries on an answer that would be
    // dropped (raw-capture-sync's posture).
    return {
      name: lane.name,
      ok: false,
      rows: null,
      reason: "r2_binding_missing",
    };
  }
  try {
    const body = await lane.compute(env);
    if (body === null) {
      console.error(
        `[projection:${lane.name}] compute declined; previous artifact left in place`,
      );
      await record(env, {
        error: new Error(`projection lane ${lane.name}: compute declined`),
        route: `projection:${lane.name}`,
      });
      return {
        name: lane.name,
        ok: false,
        rows: null,
        reason: "compute_declined",
      };
    }
    await bucket.put(lane.artifactKey, JSON.stringify(body));
    const rows = (body as { row_count?: unknown }).row_count;
    return {
      name: lane.name,
      ok: true,
      rows: typeof rows === "number" ? rows : null,
    };
  } catch (error) {
    // A throwing store is the same decline as a failed compute: the previous
    // artifact survives, and the NEXT lane still runs.
    console.error(
      `[projection:${lane.name}]`,
      String((error as Error)?.message ?? error),
    );
    await record(env, { error, route: `projection:${lane.name}` });
    return { name: lane.name, ok: false, rows: null, reason: "lane_failed" };
  }
}

/**
 * The cron entrypoint: every registered lane, sequentially. `lanes` maps each
 * lane name to the row count it wrote, or null when it wrote nothing.
 */
export async function runProjectionLanes(
  env: Env,
  deps: ProjectionLaneDeps = {},
): Promise<{
  ok: boolean;
  skipped?: true;
  reason?: string;
  lanes: Record<string, number | null>;
}> {
  if (!isR2SqlConfigured(env)) {
    // Unconfigured is a deliberate deployment state (local/CI/self-hosters
    // have no lakehouse), not a fault: skip quietly, the same contract as the
    // ACCOUNT_EVENTS_ROLLUP_CRON skip — an exception per tick forever would
    // burn the telemetry allowance announcing a permanent non-event.
    return {
      ok: false,
      skipped: true,
      reason: "r2 sql not configured",
      lanes: {},
    };
  }
  const lanes: Record<string, number | null> = {};
  let ok = true;
  for (const lane of PROJECTION_LANES) {
    const result = await runProjectionLane(env, lane, deps);
    lanes[lane.name] = result.rows;
    ok = ok && result.ok;
  }
  return { ok, lanes };
}
