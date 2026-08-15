// GET /api/v1/subnets/{netuid}/deregistration-ranking/history (#10296): one
// subnet's trajectory toward or away from the deregistration bar.
//
// `/chain/deregistration-ranking` answers the pallet's pruning order AS OF ONE
// BLOCK. #10285's own argument for why that is not enough:
//
//   > a single day's rank is noise, a trend is a warning
//
// A subnet owner reading `rank: 94` learns almost nothing. Reading "94, was 71 a
// month ago, and the price gap to rank 1 has halved" learns exactly what they
// need to act on.
//
// ## THE RANK IS NOT STORED, AND MUST NOT BE
//
// `subnet_deregistration_daily` persists the four MEASURED inputs
// (`moving_price`, `registered_at_block`, `subnet_mechanism`,
// `network_immunity_period`) and the block they were pinned at -- never the
// derived rank. That is #10296's design and this module is the other half of it:
// the ranking is REPLAYED from the stored inputs on read, so a later correction
// to the pallet rule reaches the whole series instead of leaving a record of the
// old rule's answers.
//
// ## SO A ONE-SUBNET SERIES READS EVERY SUBNET'S ROWS
//
// Rank is RELATIVE. It does not exist in one netuid's row and cannot be read off
// one. Each day is loaded whole, ranked, and only then narrowed to the subject
// -- which is what the migration's `(snapshot_date, netuid)` index is for.
// 129 subnets x 180 days is ~23,000 rows at the widest window, one indexed range
// scan.
//
// ## IT REPLAYS THROUGH rankDeregistration, NOT projectDeregistrationRanking
//
// The latter takes an ECONOMICS BLOB and internally renames `moving_price_pinned`
// -> `moving_price` before delegating. Replaying through it would mean
// synthesizing that blob and getting `moving_price_pinned` right, while the
// stored column is spelled `moving_price` -- a near-miss there produces a
// plausible ranking that is subtly not the pallet's. `rankDeregistration` is the
// layer underneath and its input is a 1:1 name match with the stored columns, so
// there is no shape to get subtly wrong.
//
// ## A DAY CAN REPEAT THE PREVIOUS DAY'S OBSERVATION, AND THAT IS PUBLISHED
//
// The same trap `/subnets/{netuid}/emission-pipeline/history` documents: a daily
// writer that carries the last capture forward when a fresh one has not landed
// makes two consecutive points THE SAME OBSERVATION. A rank that was not
// re-measured would otherwise read as a rank that held steady -- a fabricated
// finding on exactly the timeline someone would cite. So `pinned_block` rides on
// every point, each point declares `repeats_previous_observation`, and
// `distinct_observations` is published beside `point_count` as the honest
// denominator for any claim about movement.
//
// ## WHAT THE SERIES ALREADY SHOWS
//
// Replayed against production 2026-08-15, six days deep. Netuid 70 sat at rank 1
// -- `next_to_deregister` -- on 08-10 and 08-11 with `registered_at_block`
// 7,787,562. On 08-12 its `registered_at_block` is 8,825,571, one hundred and
// thirty blocks before that day's pin, its moving price is 4.0e-8, and it is
// immune for another 863,870 blocks. It was deregistered and re-registered,
// exactly as the ranking had it two days earlier, and its price has climbed back
// every day since. Netuid 36 inherited rank 1 and has fallen on every one of the
// six days. Neither fact is visible in a single day's answer.

import { SUBNET_DEREGISTRATION_DAILY_TABLE } from "./subnet-deregistration-daily.ts";
import type {
  DeregistrationHistoryArtifact,
  DeregistrationHistoryPoint,
} from "../schemas-src/routes/subnet-deregistration-history.ts";
import {
  DEREGISTRATION_HISTORY_WINDOW_DAYS,
  DEREGISTRATION_HISTORY_WINDOWS,
} from "./route-limits.ts";
import { rankDeregistration } from "./subnet-deregistration-ranking.ts";

export { DEREGISTRATION_HISTORY_WINDOW_DAYS, DEREGISTRATION_HISTORY_WINDOWS };

type Row = Record<string, unknown>;

/** The minimal store surface used here -- the owned `query()` verb, served by
 * both readStore and the producer store -- so tests can inject a plain
 * object. */
export interface DeregistrationHistoryDb {
  query?<T>(text: string, values?: unknown[]): Promise<T[]>;
}

export const DEREGISTRATION_HISTORY_TABLE = SUBNET_DEREGISTRATION_DAILY_TABLE;

/**
 * The first day the lane wrote.
 *
 * Published on every response, not merely used as a floor: with the series six
 * days deep, a caller asking for 90d and receiving six points needs to read
 * "the series BEGINS here" rather than "84 days were dropped". The same reason
 * `/network/tao-usd` publishes its own start.
 *
 * A LITERAL rather than `MIN(snapshot_date)`, deliberately. Deriving it from the
 * table makes it move when retention prunes the front of the series, so the day
 * the oldest rows age out the route would announce that the series began later
 * than it did -- and a caller could not tell a pruned window from a young one.
 */
export const DEREGISTRATION_HISTORY_FIRST_DAY = "2026-08-10";

/**
 * Every subnet's stored inputs for the days in the window, oldest first.
 *
 * NOT filtered to the subject netuid -- see the header. The `netuid` argument is
 * validated by the caller and narrowed in the builder; filtering here would
 * return rows from which no rank can be computed.
 */
export async function loadDeregistrationHistory(
  db: DeregistrationHistoryDb | null | undefined,
  {
    window = "30d",
    nowMs = Date.now(),
  }: { window?: string; nowMs?: number } = {},
): Promise<Row[] | null> {
  if (!db?.query) return null;
  const days = DEREGISTRATION_HISTORY_WINDOW_DAYS[window];
  if (days === undefined) return null;
  try {
    return await db.query<Row>(
      `SELECT snapshot_date, netuid, moving_price, registered_at_block,` +
        ` subnet_mechanism, network_immunity_period, pinned_block, captured_at` +
        ` FROM ${DEREGISTRATION_HISTORY_TABLE}` +
        ` WHERE snapshot_date >= ?` +
        ` ORDER BY snapshot_date ASC, netuid ASC`,
      [utcDay(nowMs - days * 86_400_000)],
    );
  } catch {
    return null;
  }
}

/** One day's rows, in load order, keyed by day and kept in that order. */
function byDay(rows: Row[]): Map<string, Row[]> {
  const days = new Map<string, Row[]>();
  for (const row of rows) {
    const day = stringOrNull(row?.snapshot_date);
    if (day === null) continue;
    const bucket = days.get(day);
    if (bucket) bucket.push(row);
    else days.set(day, [row]);
  }
  return days;
}

/**
 * Shape the series. Pure, so the same rows produce the same payload wherever
 * they came from -- which is what makes the replay testable against a fixture
 * rather than against a store.
 *
 * An empty series is a real answer, not a decline: a subnet registered after the
 * lane began, or a window narrower than the days that exist, both legitimately
 * return nothing. `first_captured_day` is what tells those apart from a broken
 * read.
 */
export function buildDeregistrationHistory(
  rows: Row[] | null | undefined,
  netuid: number,
  { window }: { window?: string } = {},
): DeregistrationHistoryArtifact {
  const points: DeregistrationHistoryPoint[] = [];
  let previousBlock: number | null = null;
  let distinct = 0;

  for (const [day, dayRows] of byDay(Array.isArray(rows) ? rows : [])) {
    // Both are per-day facts written identically onto every row of that day, so
    // the first readable one answers for the day. Taken from the rows rather
    // than from the subject's row specifically: the subject may not exist yet,
    // and the day is still rankable without it.
    const block = firstInt(dayRows, "pinned_block");
    const immunity = firstInt(dayRows, "network_immunity_period");

    const replayed = rankDeregistration({
      block,
      networkImmunityPeriod: immunity,
      candidates: dayRows.map((row) => ({
        netuid: Number(row?.netuid),
        moving_price: numberOrNull(row?.moving_price),
        registered_at_block: intOrNull(row?.registered_at_block),
        subnet_mechanism: intOrNull(row?.subnet_mechanism),
      })),
    });
    // A day whose stored inputs cannot be ranked is DROPPED rather than emitted
    // with null cells. The writer already gates on the same inputs, so this is
    // the pre-lane past and a partially-written day -- neither is a point in a
    // trajectory, and both would read as "this subnet had no rank that day",
    // which is a different and false statement.
    if (!replayed.ok) continue;
    const { ranking } = replayed;

    const ranked = ranking.ranked.find((entry) => entry.netuid === netuid);
    const immune = ranking.immune.find((entry) => entry.netuid === netuid);
    const entry = ranked ?? immune;
    // The subject did not exist on this day (registered later, or root, which
    // the pallet's rule excludes). Not a gap in the series -- an absence from
    // it.
    if (!entry) continue;

    const repeats = previousBlock !== null && ranking.block === previousBlock;
    if (!repeats) distinct += 1;
    previousBlock = ranking.block;

    const leader = ranking.ranked[0] ?? null;
    points.push({
      day,
      pinned_block: ranking.block,
      repeats_previous_observation: repeats,
      captured_at: toIsoOrNull(firstValue(dayRows, "captured_at")),
      // NULL while immune, never a number: an immune subnet holds no position
      // in the prunable order, and reporting one would invent a standing it
      // does not have. `immune` beside it is what distinguishes that from an
      // unreadable rank.
      rank: entry.rank,
      immune: entry.immune,
      immune_until_block: entry.immune_until_block,
      blocks_until_prunable: entry.blocks_until_prunable,
      // What the pallet COMPARES, and the raw read beside it, so the Stable
      // mechanism's flat 1.0 substitution stays visible rather than inferred --
      // the same pairing the live ranking publishes.
      comparison_price: entry.comparison_price,
      moving_price: entry.moving_price,
      registered_at_block: entry.registered_at_block,
      subnet_mechanism: entry.subnet_mechanism,
      network_immunity_period: ranking.network_immunity_period,
      // The FIELD SIZE, because rank 94 means different things in a field of 100
      // and a field of 128 -- #10296 asks for this explicitly.
      ranked_count: ranking.ranked.length,
      immune_count: ranking.immune.length,
      // Who was at the bar that day, and at what price. Published rather than a
      // pre-computed "gap": the distance a caller cares about depends on which
      // question they are asking, and a single derived number would pick one.
      next_to_deregister: ranking.next_to_deregister,
      next_to_deregister_comparison_price: leader
        ? leader.comparison_price
        : null,
    });
  }

  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    // Points emitted. NOT the number of times the inputs were read.
    point_count: points.length,
    // How many of those are independent observations. Any claim that a rank
    // MOVED rests on this, not on point_count.
    distinct_observations: distinct,
    // The depth that EXISTS, from the rows -- not the window requested.
    oldest_day: points.length ? points[0]!.day : null,
    newest_day: points.length ? points[points.length - 1]!.day : null,
    first_captured_day: DEREGISTRATION_HISTORY_FIRST_DAY,
    points,
  };
}

/** A decline, for a read that could not be made at all. */
export function declineDeregistrationHistory(
  reason: "unavailable",
  netuid: number,
  { window }: { window?: string } = {},
): DeregistrationHistoryArtifact {
  return {
    schema_version: 1,
    netuid,
    window: window ?? null,
    degraded: { reason },
    // NULL, not zero: nothing is known about how many days exist, and a zero
    // would assert this subnet has never been ranked.
    point_count: null,
    distinct_observations: null,
    oldest_day: null,
    newest_day: null,
    first_captured_day: DEREGISTRATION_HISTORY_FIRST_DAY,
    points: [],
  };
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** The first readable integer for `key` across a day's rows. */
function firstInt(rows: Row[], key: string): number | null {
  for (const row of rows) {
    const n = intOrNull(row?.[key]);
    if (n !== null) return n;
  }
  return null;
}

function firstValue(rows: Row[], key: string): unknown {
  for (const row of rows) if (row?.[key] != null) return row[key];
  return null;
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
