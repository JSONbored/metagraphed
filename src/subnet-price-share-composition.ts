// Bounded observed-price-share history for the explorer landing page (#11550).
//
// Alpha stake is denominated by subnet and cannot be stacked across netuids.
// This projection instead uses the economics artifact's normalized moving-price
// share. It is deliberately distinct from the runtime v440 Stage-1 share:
// legacy snapshots retain Root in their denominator and carry no historic
// eligibility inputs. Historical subnet snapshots also have no completed-pass
// manifest, so the output is an estimated observed-price-set composition,
// never a claim about final TAO emission or total network stake.

import { DAY_MS } from "../workers/config.ts";
import { storeAll, type ObservationsReadDb } from "./analytics-live.ts";

type Row = Record<string, unknown>;

/** Number of recorded UTC days the compact landing-page contract targets. */
export const SUBNET_PRICE_SHARE_COMPOSITION_TARGET_DAY_COUNT = 56;
/** Fixed cohort size; one derived `other` series is added after it. */
export const SUBNET_PRICE_SHARE_COMPOSITION_SERIES_LIMIT = 6;
/** Read enough history to survive dates without a valid normalized row set. */
export const SUBNET_PRICE_SHARE_COMPOSITION_SOURCE_DAY_COUNT = 90;
// 90 daily snapshots × a deliberately generous 256 netuids. One extra row is
// read to detect an over-cap result. Its terminal date is then conservatively
// omitted because the loaded rows may not contain that date's full row set.
export const SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP = 23_040;

const SHARE_DECIMAL_PLACES = 6;
const SHARE_SCALE = 10 ** SHARE_DECIMAL_PLACES;
// `z.iso.datetime()` intentionally excludes JavaScript's extended ISO years.
// Never construct a response timestamp it cannot validate.
const MAX_WRITER_CAPTURED_AT = Date.parse("9999-12-31T23:59:59.999Z");

interface DailyPriceShareObservation {
  snapshot_date: string;
  seen_netuids: Set<number>;
  captures: Map<number, Map<number, number>>;
}

interface ObservedPriceShareObservation {
  snapshot_date: string;
  writer_captured_at: number;
  /** Integer millionths: exact six-decimal artifact share units. */
  share_units: Map<number, number>;
  observed_price_share_total_units: number;
}

interface CompositionBuildOptions {
  targetDayCount?: number;
  seriesLimit?: number;
  truncatedOldestDay?: string | null;
}

function emptyComposition({
  targetDayCount,
  seriesLimit,
}: Required<Pick<CompositionBuildOptions, "targetDayCount" | "seriesLimit">>) {
  return {
    schema_version: 1,
    metric: "artifact_normalized_moving_price_share" as const,
    observation_basis: "estimated_observed_price_set" as const,
    target_day_count: targetDayCount,
    series_limit: seriesLimit,
    reference_day: null,
    reference_writer_captured_at: null,
    point_count: 0,
    oldest_day: null,
    newest_day: null,
    series: [],
    days: [],
  };
}

function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function toNonNegativeInt(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function toWriterCapturedAt(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) &&
    number >= 1_000_000_000_000 &&
    number <= MAX_WRITER_CAPTURED_AT
    ? number
    : null;
}

/**
 * `null` is a valid source absence (no reported positive moving price);
 * `undefined` is malformed input and invalidates its date.
 */
function toPriceShareUnits(value: unknown): number | null | undefined {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    return undefined;
  }
  const units = Math.round(number * SHARE_SCALE);
  // Database numbers round-trip through JavaScript, so a true six-decimal
  // source value can land a few ULPs away from its integer millionth. That is
  // accepted; an off-grid source value (for example 0.5000001) is not.
  return Math.abs(number * SHARE_SCALE - units) <=
    Number.EPSILON * SHARE_SCALE * 4
    ? units
    : undefined;
}

function sumShareUnits(shares: Iterable<number>): number {
  let total = 0;
  for (const share of shares) total += share;
  return total;
}

function shareFromUnits(units: number): number {
  return units / SHARE_SCALE;
}

function writerCapturedAtIso(writerCapturedAt: number): string {
  return new Date(writerCapturedAt).toISOString();
}

function roundedSumToleranceUnits(pricedSubnetCount: number): number {
  // Each persisted share is rounded to six decimals before the Worker writes
  // it. Integer millionths avoid a floating-point allowance while preserving
  // the maximum aggregate rounding error of the source artifact.
  return pricedSubnetCount * 0.5;
}

function observedDays(
  rows: readonly Row[] | null | undefined,
  truncatedOldestDay: string | null,
): ObservedPriceShareObservation[] {
  const byDay = new Map<string, DailyPriceShareObservation>();
  const invalidDays = new Set<string>();

  for (const row of rows || []) {
    const day = row?.snapshot_date;
    if (!isUtcDay(day)) continue;
    const netuid = toNonNegativeInt(row.netuid);
    const shareUnits = toPriceShareUnits(row.emission_share);
    if (netuid === null || shareUnits === undefined) {
      invalidDays.add(day);
      continue;
    }

    const observation = byDay.get(day) ?? {
      snapshot_date: day,
      seen_netuids: new Set<number>(),
      captures: new Map<number, Map<number, number>>(),
    };
    if (observation.seen_netuids.has(netuid)) {
      // The source primary key should rule this out. A duplicate has no
      // canonical meaning, so omit the date instead of choosing one record.
      invalidDays.add(day);
      continue;
    }
    observation.seen_netuids.add(netuid);
    byDay.set(day, observation);

    // A source absence is not a zero share. It does not take part in the
    // normalized observed-price set, so it cannot be a chart series.
    if (shareUnits === null) continue;
    const writerCapturedAt = toWriterCapturedAt(row.captured_at);
    if (writerCapturedAt === null) {
      invalidDays.add(day);
      continue;
    }
    const shares = observation.captures.get(writerCapturedAt) ?? new Map();
    shares.set(netuid, shareUnits);
    observation.captures.set(writerCapturedAt, shares);
  }

  const days = [...byDay.values()]
    .flatMap((day) => {
      // A same-date row set mixed across writer timestamps can result from a
      // degraded sequential upsert. Do not blend it into one visual bar.
      if (invalidDays.has(day.snapshot_date) || day.captures.size !== 1) {
        return [];
      }
      const [writerCapturedAt, shares] = [...day.captures.entries()][0]!;
      const observedPriceShareTotalUnits = sumShareUnits(shares.values());
      if (
        shares.size === 0 ||
        Math.abs(observedPriceShareTotalUnits - SHARE_SCALE) >
          roundedSumToleranceUnits(shares.size)
      ) {
        return [];
      }
      return [
        {
          snapshot_date: day.snapshot_date,
          writer_captured_at: writerCapturedAt,
          share_units: shares,
          observed_price_share_total_units: observedPriceShareTotalUnits,
        },
      ];
    })
    .sort((left, right) =>
      right.snapshot_date.localeCompare(left.snapshot_date),
    );

  // The cap can truncate only its raw oldest snapshot_date. Drop that exact
  // date, rather than a later valid date when a malformed raw tail was already
  // filtered out by the observed-row rules above.
  return truncatedOldestDay === null
    ? days
    : days.filter((day) => day.snapshot_date !== truncatedOldestDay);
}

function cohortFor(
  observation: ObservedPriceShareObservation,
  seriesLimit: number,
): Array<[number, number]> | null {
  const cohort = [...observation.share_units.entries()]
    .sort(([leftNetuid, leftShare], [rightNetuid, rightShare]) => {
      if (leftShare === rightShare) return leftNetuid - rightNetuid;
      return rightShare - leftShare;
    })
    .slice(0, seriesLimit);
  // Never hide a material sum overflow by clamping `other` to zero. A cohort
  // whose recorded shares already exceed the full normalized domain is not a
  // valid reference for this fixed-color chart.
  return sumShareUnits(cohort.map(([, share]) => share)) <= SHARE_SCALE
    ? cohort
    : null;
}

/**
 * Pure response builder. It requires one persisted writer timestamp for the
 * numeric shares in each date, keeps a stable newest eligible cohort, and
 * never blends partial or mixed rows into a complete-looking 100%-stacked
 * visual. A shared writer timestamp is a mixed-write guard, not a completed
 * source-pass certificate.
 */
export function buildSubnetPriceShareComposition(
  rows: readonly Row[] | null | undefined,
  {
    targetDayCount = SUBNET_PRICE_SHARE_COMPOSITION_TARGET_DAY_COUNT,
    seriesLimit = SUBNET_PRICE_SHARE_COMPOSITION_SERIES_LIMIT,
    truncatedOldestDay = null,
  }: CompositionBuildOptions = {},
) {
  const empty = emptyComposition({ targetDayCount, seriesLimit });
  const newestFirst = observedDays(rows, truncatedOldestDay);
  const referenceIndex = newestFirst.findIndex(
    (observation) => cohortFor(observation, seriesLimit) !== null,
  );
  if (referenceIndex < 0) return empty;
  const reference = newestFirst[referenceIndex]!;
  const cohort = cohortFor(reference, seriesLimit)!;
  const selectedNetuids = cohort.map(([netuid]) => netuid);
  const eligibleDays = newestFirst.slice(referenceIndex);
  const series = [
    ...cohort.map(([netuid, share]) => ({
      id: `subnet:${netuid}`,
      kind: "subnet" as const,
      netuid,
      label: null,
      reference_price_share: shareFromUnits(share),
    })),
    {
      id: "other",
      kind: "other" as const,
      netuid: null,
      label: "Other artifact-normalized price share",
      reference_price_share: shareFromUnits(
        SHARE_SCALE - sumShareUnits(cohort.map(([, share]) => share)),
      ),
    },
  ];

  const daily = eligibleDays
    .filter((day) =>
      selectedNetuids.every((netuid) => day.share_units.has(netuid)),
    )
    .filter(
      (day) =>
        sumShareUnits(
          selectedNetuids.map((netuid) => day.share_units.get(netuid)!),
        ) <= SHARE_SCALE,
    )
    .slice(0, targetDayCount)
    .reverse()
    .map((day) => {
      const selectedTotalUnits = sumShareUnits(
        selectedNetuids.map((netuid) => day.share_units.get(netuid)!),
      );
      const values: Array<{
        series_id: string;
        price_share: number;
        source: "recorded" | "derived";
      }> = selectedNetuids.map((netuid) => ({
        series_id: `subnet:${netuid}`,
        price_share: shareFromUnits(day.share_units.get(netuid)!),
        source: "recorded" as const,
      }));
      values.push({
        series_id: "other",
        price_share: shareFromUnits(SHARE_SCALE - selectedTotalUnits),
        source: "derived" as const,
      });
      return {
        snapshot_date: day.snapshot_date,
        writer_captured_at: writerCapturedAtIso(day.writer_captured_at),
        priced_subnet_count: day.share_units.size,
        observed_price_share_total: shareFromUnits(
          day.observed_price_share_total_units,
        ),
        values,
      };
    });

  return {
    schema_version: 1,
    metric: "artifact_normalized_moving_price_share" as const,
    observation_basis: "estimated_observed_price_set" as const,
    target_day_count: targetDayCount,
    series_limit: seriesLimit,
    reference_day: reference.snapshot_date,
    reference_writer_captured_at: writerCapturedAtIso(
      reference.writer_captured_at,
    ),
    point_count: daily.length,
    oldest_day: daily[0]!.snapshot_date,
    newest_day: daily[daily.length - 1]!.snapshot_date,
    series,
    days: daily,
  };
}

/**
 * One bounded store query for the landing-page timeline. Today is excluded as
 * an additional guard, but returned historical points are still marked as an
 * estimated observed-price set because legacy snapshots lack a daily manifest.
 */
export async function loadSubnetPriceShareComposition({
  db = null,
  now = Date.now(),
}: {
  db?: ObservationsReadDb | null;
  now?: number;
} = {}): Promise<{
  data: ReturnType<typeof buildSubnetPriceShareComposition>;
  rows: Row[];
}> {
  const today = new Date(now).toISOString().slice(0, 10);
  const firstDay = new Date(
    now - SUBNET_PRICE_SHARE_COMPOSITION_SOURCE_DAY_COUNT * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const rows = await storeAll(
    db,
    "SELECT snapshot_date, netuid, emission_share, captured_at FROM subnet_snapshots " +
      "WHERE snapshot_date >= ? AND snapshot_date < ? " +
      "ORDER BY snapshot_date DESC, captured_at DESC, netuid ASC LIMIT ?",
    [firstDay, today, SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP + 1],
  );
  const rawOldestDay = rows[rows.length - 1]?.snapshot_date;
  const truncatedOldestDay =
    rows.length > SUBNET_PRICE_SHARE_COMPOSITION_ROW_CAP &&
    isUtcDay(rawOldestDay)
      ? rawOldestDay
      : null;
  return {
    data: buildSubnetPriceShareComposition(rows, {
      truncatedOldestDay,
    }),
    rows,
  };
}
