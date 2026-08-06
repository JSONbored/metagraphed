// GET /api/v1/chain/concentration/history (#9628): is the NETWORK getting more
// concentrated?
//
// /subnets/{netuid}/concentration/history has answered that one subnet at a
// time since it shipped. The network-wide card at /chain/concentration had no
// series at all, so "is subnet 74 concentrating?" was one request and "is
// Bittensor concentrating?" was unanswerable.
//
// ## THIS READS A ROLLUP, AND THE ROLLUP RAN THE SERVING BUILDER
//
// The per-subnet route computes Gini/HHI/Nakamoto in JS from raw per-UID rows,
// which works because a netuid slice is ~256 of them. Network-wide it is not a
// slice: `neuron_daily` holds 816,803 rows across 27 days, ~30,100 a day, so a
// 30-day series computed that way would pull ~900,000 rows into one request.
// The cron computes each day once with `buildChainConcentration` -- the same
// function /chain/concentration serves -- and this reads the stored cards.
//
// ## A STORED COMPUTATION FREEZES THE CODE THAT PRODUCED IT
//
// That is the cost of the rollup, and it is published rather than hidden. If
// the builder changes, points computed before the change and after it disagree
// BY CONSTRUCTION -- not because the network moved. Each point carries the
// `builder_version` it was computed under and the series reports
// `builder_versions`, so a caller comparing across a version boundary can see
// that they are comparing two definitions.
//
// ## THE DEPTH IS THE ROLLUP'S, NOT THE WINDOW'S
//
// `neuron_daily` is itself only ~27 days deep and the rollup cannot predate it,
// so a 90d window returns what exists. `oldest_day`/`newest_day` and
// `point_count` come from the rows, and a day the capture did not run is
// ABSENT -- never a zero-concentration point, which would read as a perfectly
// distributed network.

import {
  CHAIN_CONCENTRATION_HISTORY_WINDOWS,
  CHAIN_CONCENTRATION_HISTORY_WINDOW_DAYS,
} from "./route-limits.ts";

export {
  CHAIN_CONCENTRATION_HISTORY_WINDOWS,
  CHAIN_CONCENTRATION_HISTORY_WINDOW_DAYS,
};

type Row = Record<string, unknown>;

export interface ChainConcentrationHistoryDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
  };
}

export const CHAIN_CONCENTRATION_HISTORY_TABLE = "chain_concentration_daily";

/** One window of stored cards, oldest day first. */
export async function loadChainConcentrationHistory(
  db: ChainConcentrationHistoryDb | null | undefined,
  {
    window = "30d",
    nowMs = Date.now(),
  }: { window?: string; nowMs?: number } = {},
): Promise<Row[] | null> {
  if (!db?.prepare) return null;
  const days = CHAIN_CONCENTRATION_HISTORY_WINDOW_DAYS[window];
  if (days === undefined) return null;
  try {
    const res = await (
      db
        .prepare(
          "SELECT day, neuron_count, card, source_captured_at," +
            " builder_version" +
            ` FROM ${CHAIN_CONCENTRATION_HISTORY_TABLE}` +
            " WHERE day >= ? ORDER BY day ASC",
        )
        .bind(utcDay(nowMs - days * 86_400_000)) as {
        all?(): Promise<{ results?: unknown[] } | null>;
      }
    ).all?.();
    return (res?.results ?? []) as Row[];
  } catch {
    return null;
  }
}

/**
 * Shape the series. Pure, so the same rows produce the same payload wherever
 * they came from.
 *
 * An empty window is a real answer, not a decline: a window narrower than the
 * rollup's depth returns nothing legitimately, and `point_count: 0` says so.
 */
export function buildChainConcentrationHistory(
  rows: Row[] | null | undefined,
  { window }: { window?: string } = {},
): Row {
  const points: Row[] = [];
  const versions = new Set<number>();

  for (const r of Array.isArray(rows) ? rows : []) {
    const day = stringOrNull(r?.day);
    const card = parseCard(r?.card);
    // A point with no day cannot take a position in a series, and one whose
    // stored card will not parse cannot be presented as a measurement -- there
    // is nothing behind it to serve.
    if (day === null || card === null) continue;

    const version = intOrNull(r?.builder_version);
    if (version !== null) versions.add(version);

    points.push({
      day,
      // The shape of the day the card was computed over. A point computed
      // across half the network is not comparable to one across all of it.
      //
      // Only neuron_count is a column -- the other two come from the CARD,
      // which is where the rollup already put them. A second copy in a column
      // is a second thing that can disagree with the first.
      neuron_count: intOrNull(r?.neuron_count),
      subnet_count: intOrNull(card.subnet_count),
      entity_count: intOrNull(card.entity_count),
      // WHEN the network looked like this, as distinct from when it was
      // computed.
      source_captured_at: toIsoOrNull(r?.source_captured_at),
      // Which definition of the metrics produced this point -- see the module
      // header. Comparing across a change here compares two definitions.
      builder_version: version,
      uids_per_entity: numberOrNull(card.uids_per_entity),
      stake: scorecardOrNull(card.stake),
      emission: scorecardOrNull(card.emission),
      entity_stake: scorecardOrNull(card.entity_stake),
      entity_emission: scorecardOrNull(card.entity_emission),
      validator_stake: scorecardOrNull(card.validator_stake),
    });
  }

  return {
    schema_version: 1,
    window: window ?? null,
    // From the ROWS. A day the capture did not run is absent, never a
    // zero-concentration point -- which would read as a perfectly distributed
    // network on a day nothing was measured.
    point_count: points.length,
    oldest_day: points.length ? points[0].day : null,
    newest_day: points.length ? points[points.length - 1].day : null,
    // Every distinct builder version in the series, ascending. More than one
    // means the series changes DEFINITION partway along, and a trend drawn
    // across the boundary is not a trend.
    builder_versions: [...versions].sort((a, b) => a - b),
    points,
  };
}

/** A decline, for a read that could not be made at all. */
export function declineChainConcentrationHistory(
  reason: "unavailable",
  { window }: { window?: string } = {},
): Row {
  return {
    schema_version: 1,
    window: window ?? null,
    degraded: { reason },
    // NULL, not zero: nothing is known about how many days were rolled up, and
    // a zero would assert the network has never been measured.
    point_count: null,
    oldest_day: null,
    newest_day: null,
    builder_versions: [],
    points: [],
  };
}

/**
 * The stored card, or null.
 *
 * A card that will not parse is dropped rather than served as a point with
 * empty metrics: an empty scorecard reads as a measured absence of
 * concentration, which is the opposite of "we could not read this".
 */
function parseCard(value: unknown): Row | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    // An ARRAY is JSON, and an object, and not a card. Without this it would
    // reach the payload as a point whose every lens is undefined -- the exact
    // "measured absence of concentration" this function exists to prevent.
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Row)
      : null;
  } catch {
    return null;
  }
}

/**
 * One scorecard, passed through as stored.
 *
 * NULL is a legitimate value from computeConcentration -- it returns null when
 * a distribution has no positive values at all -- so a null here means "no
 * measurable distribution", not "missing", and substituting zeros would invent
 * a perfectly equal one.
 */
function scorecardOrNull(value: unknown): Row | null {
  return typeof value === "object" && value !== null ? (value as Row) : null;
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

/** 'YYYY-MM-DD' in UTC, matching the rollup's own `day` format. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
