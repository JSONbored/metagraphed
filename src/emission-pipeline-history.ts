// GET /api/v1/subnets/{netuid}/emission-pipeline/history (#9625): one subnet's
// emission-pipeline decomposition over time.
//
// /chain/emission-pipeline decomposes the v440 pipeline for every subnet AS OF
// ONE BLOCK. `subnet_snapshots` has been persisting that decomposition daily
// since 2026-08-02 -- tao_in_emission_tao, excess_tao, alpha_in/out_emission,
// miner_burned_fraction, emission_enabled, emission_share, tao_in_pool_tao,
// each pinned by pipeline_block/pipeline_block_hash -- and no route read the
// series. "Was this subnet's miner burn climbing before its emission dropped?"
// was unanswerable from data already in the table.
//
// ## THE DEPTH IS FIVE DAYS AND THE ROUTE SAYS SO
//
// The table holds 50,762 rows across 409 days; the PIPELINE columns hold 645
// rows across 5 (measured 2026-08-06, 129 subnets a day with no gaps). A route
// reporting the window it was asked for rather than the data it found would
// present 404 days of nulls as history. `oldest_day`/`newest_day` and
// `point_count` come from the rows.
//
// ## A DAY CAN REPEAT THE PREVIOUS DAY'S OBSERVATION, AND THAT IS PUBLISHED
//
// The daily snapshot writer copies the last pipeline capture forward when a
// fresh one has not landed for that day. Measured 2026-08-06: that day's row
// was captured at 05:00 UTC carrying block 8777280 -- yesterday's -- while the
// chain was at 8782513. A timing artifact rather than a stall, and it
// self-corrects, but it means two consecutive points can be THE SAME
// OBSERVATION.
//
// A consumer reading them as two daily samples would conclude a value was flat
// when it was simply not re-measured, which is a fabricated finding on exactly
// the timeline someone would cite. So `pipeline_block` rides on every point,
// each point declares `repeats_previous_observation`, and the summary reports
// `distinct_observations` beside `point_count` -- the number of times the
// pipeline was actually read, which is the honest denominator for any claim
// about how it moved.

import {
  PIPELINE_HISTORY_WINDOW_DAYS,
  PIPELINE_HISTORY_WINDOWS,
} from "./route-limits.ts";

export { PIPELINE_HISTORY_WINDOW_DAYS, PIPELINE_HISTORY_WINDOWS };

type Row = Record<string, unknown>;

export interface PipelineHistoryDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

export const PIPELINE_HISTORY_TABLE = "subnet_snapshots";

/**
 * The first day the pipeline columns were written.
 *
 * Published on every response, not just used as a floor: a caller asking for
 * 90d and receiving 5 points needs to know the series BEGINS here rather than
 * suspecting the other 85 days were dropped.
 */
export const PIPELINE_HISTORY_FIRST_DAY = "2026-08-02";

/**
 * One subnet's series, oldest day first.
 *
 * `pipeline_block IS NOT NULL` is the filter, not a date floor: the column is
 * what marks a row as carrying a pipeline capture at all, and 404 days of rows
 * predating the capture would otherwise arrive as points made entirely of
 * nulls.
 */
export async function loadPipelineHistory(
  db: PipelineHistoryDb | null | undefined,
  netuid: number,
  {
    window = "30d",
    nowMs = Date.now(),
  }: { window?: string; nowMs?: number } = {},
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  const days = PIPELINE_HISTORY_WINDOW_DAYS[window];
  if (days === undefined) return null;
  try {
    const res = await (
      db
        .prepare(
          `SELECT snapshot_date, pipeline_block, pipeline_block_hash,` +
            ` emission_share, tao_in_pool_tao, tao_in_emission_tao, excess_tao,` +
            ` alpha_in_emission, alpha_out_emission, miner_burned_fraction,` +
            ` emission_enabled, first_emission_block, alpha_price_tao,` +
            ` captured_at` +
            ` FROM ${PIPELINE_HISTORY_TABLE}` +
            ` WHERE netuid = ? AND pipeline_block IS NOT NULL` +
            ` AND snapshot_date >= ?` +
            ` ORDER BY snapshot_date ASC`,
        )
        .bind(netuid, utcDay(nowMs - days * 86_400_000)) as {
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
 * An empty series is a real answer, not a decline: a subnet registered after
 * the capture began, or a window narrower than the 5 days that exist, both
 * legitimately return nothing. `first_captured_day` is what tells those apart
 * from a broken read.
 */
export function buildPipelineHistory(
  rows: Row[] | null | undefined,
  netuid: unknown,
  { window }: { window?: string } = {},
): Row {
  const points: Row[] = [];
  let previousBlock: number | null = null;
  let distinct = 0;

  for (const r of Array.isArray(rows) ? rows : []) {
    const day = stringOrNull(r?.snapshot_date);
    const block = intOrNull(r?.pipeline_block);
    // A point with no day cannot take a position in a series, and one with no
    // pinned block cannot say which chain state it describes -- the two things
    // that make this a series rather than a bag of numbers.
    if (day === null || block === null) continue;

    // The honesty flag. True means the snapshot writer carried the previous
    // capture forward because a fresh one had not landed for this day, so this
    // point is NOT an independent sample.
    const repeats = previousBlock !== null && block === previousBlock;
    if (!repeats) distinct += 1;
    previousBlock = block;

    points.push({
      day,
      pipeline_block: block,
      pipeline_block_hash: stringOrNull(r?.pipeline_block_hash),
      repeats_previous_observation: repeats,
      captured_at: toIsoOrNull(r?.captured_at),
      emission_share: numberOrNull(r?.emission_share),
      alpha_price_tao: numberOrNull(r?.alpha_price_tao),
      tao_in_pool_tao: numberOrNull(r?.tao_in_pool_tao),
      // The TAO split: pool liquidity injection vs chain buys.
      tao_in_emission_tao: numberOrNull(r?.tao_in_emission_tao),
      excess_tao: numberOrNull(r?.excess_tao),
      alpha_in_emission: numberOrNull(r?.alpha_in_emission),
      alpha_out_emission: numberOrNull(r?.alpha_out_emission),
      miner_burned_fraction: numberOrNull(r?.miner_burned_fraction),
      // 0/1 with a CHECK behind it, so anything else is unreadable rather than
      // false -- `false` would assert the subnet's emission was switched off.
      emission_enabled: boolOrNull(r?.emission_enabled),
      first_emission_block: intOrNull(r?.first_emission_block),
    });
  }

  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    // Rows returned. NOT the number of times the pipeline was read.
    point_count: points.length,
    // How many of those points are independent samples. Any claim about how a
    // value MOVED rests on this, not on point_count: a carried-forward day is
    // the same observation twice, and reading it as flatness is a finding the
    // data does not support.
    distinct_observations: distinct,
    // The depth that EXISTS, from the rows -- not the window requested.
    oldest_day: points.length ? points[0].day : null,
    newest_day: points.length ? points[points.length - 1].day : null,
    // Published on every response so a caller receiving 5 points for a 90d
    // window knows the series BEGINS here rather than that days were dropped.
    first_captured_day: PIPELINE_HISTORY_FIRST_DAY,
    points,
  };
}

/** A decline, for a read that could not be made at all. */
export function declinePipelineHistory(
  reason: "unavailable",
  netuid: unknown,
  { window }: { window?: string } = {},
): Row {
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    degraded: { reason },
    // NULL, not zero: nothing is known about how many captures exist, and a
    // zero would assert this subnet has never been decomposed.
    point_count: null,
    distinct_observations: null,
    oldest_day: null,
    newest_day: null,
    first_captured_day: PIPELINE_HISTORY_FIRST_DAY,
    points: [],
  };
}

function boolOrNull(value: unknown): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIsoOrNull(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 'YYYY-MM-DD' in UTC, matching snapshot_date's own format. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
