/**
 * Derived alpha-price %-change windows for subnet economics listings (#7227).
 *
 * Source series is the same daily `subnet_snapshots.alpha_price_tao` history
 * `/api/v1/subnets/{netuid}/trajectory` already reads. Windows that lack a
 * prior finite price resolve to `null` (schema-stable) — never an error.
 *
 * `alpha_price_change_1h` is always `null` here: this series is daily, and a
 * daily series cannot answer an hour window.
 *
 * That is now a DELIBERATE gap rather than a pending one. The original note
 * called OHLC "a separate future source"; it has since shipped, with `1h` as
 * its default interval (OHLC_INTERVALS, src/subnet-ohlc.ts), so an intraday
 * price is available. It is still not wired in here, because OHLC is built
 * from stake add/remove EVENTS -- a traded price -- while these windows are
 * built from `alpha_price_tao`, the pinned moving average. Filling 1h from
 * OHLC would make one member of a four-field family answer a different
 * question from its siblings, which is worse than a null: a reader comparing
 * 1h against 1d would be comparing two different prices without being told.
 *
 * Wiring it up is a real option, but it means either moving all four windows
 * onto the traded series or documenting the split explicitly -- a decision,
 * not an omission.
 */

export const ALPHA_PRICE_CHANGE_WINDOWS: Record<string, number | null> =
  Object.freeze({
    // Null = this window is not answerable from a daily series. Kept as a key
    // for a stable schema shape; see the header for why the now-shipped
    // intraday OHLC source is deliberately not used to fill it.
    "1h": null,
    "1d": 1,
    "7d": 7,
    // Match trajectory's 30d window naming (1m ≈ calendar month).
    "1m": 30,
  });

/** Signed percentage change start→end, rounded to 2dp. Null when undefined. */
export function pctChange(start: number, end: number): number | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) {
    return null;
  }
  return Math.round(((end - start) / start) * 100 * 100) / 100;
}

function toFiniteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface AlphaPricePoint {
  date: string;
  alpha_price_tao: number | null;
  /**
   * When this row was actually written, epoch ms. Null for rows that predate
   * the column or arrive from a caller that does not carry it.
   *
   * #9449: this is what makes a window mean what it says. A snapshot row is
   * UPSERTED throughout its own day (the health prober rewrites today's row
   * every run), so a row's date identifies which day it belongs to and says
   * nothing about how far apart two rows were measured. Live data on
   * 2026-08-05: the 08-05 row was captured 00:00:08 and the 08-04 row
   * 23:00:08 -- one hour apart, treated as a day.
   */
  captured_at: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toEpochMsOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * When a point was measured, for window arithmetic.
 *
 * Falls back to the END of its calendar day when the row carries no
 * `captured_at`. That is the right default rather than midnight: the live
 * writer's last successful upsert for a day lands late in it (~23:00 in
 * production), so end-of-day is what an untimestamped historical row actually
 * represents. Using midnight would systematically overstate every gap by
 * nearly a day.
 */
function effectiveAt(point: AlphaPricePoint): number {
  if (point.captured_at != null) return point.captured_at;
  const [y, m, d] = point.date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + DAY_MS - 1;
}

/**
 * Normalize snapshot rows into ascending `{ date, alpha_price_tao }` points.
 * Accepts trajectory-shaped rows (`snapshot_date`) or already-normalized points.
 */
export function normalizeAlphaPricePoints(
  rows: Array<Record<string, unknown>> | null | undefined,
): AlphaPricePoint[] {
  const points: AlphaPricePoint[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const date = row.date ?? row.snapshot_date;
    if (date == null || date === "") continue;
    const day = String(date).slice(0, 10);
    // Reject non-calendar prefixes so effectiveAt never sees partial dates.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    points.push({
      date: day,
      alpha_price_tao: toFiniteOrNull(row.alpha_price_tao),
      captured_at: toEpochMsOrNull(row.captured_at),
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

/**
 * The newest point measured at least `days` before `latest`, by actual
 * elapsed time.
 *
 * #9449: this replaced a calendar-date lookup (`latest.date - days`, then the
 * newest row on or before that date), which was wrong in a way that produced
 * a CONFIDENT WRONG ANSWER rather than a missing one. Snapshot rows are
 * upserted through their own day, so the row dated "yesterday" holds
 * yesterday's LAST measurement (~23:00) while the row dated "today" holds
 * one taken minutes ago. Just after midnight UTC those two rows are an hour
 * apart, and since the economics source they both read refreshes only every
 * ~3h, they carried a byte-identical price -- so `alpha_price_change_1d`
 * reported exactly 0 for ALL 129 subnets, every day, for the first hours of
 * each UTC day. Not null, not absent: 0, which a consumer plots as "flat".
 *
 * Selecting by elapsed time makes the window mean what its name says
 * regardless of when in the day either row happened to land.
 */
function priorPointAtLeast(
  points: AlphaPricePoint[],
  latest: AlphaPricePoint,
  days: number,
): AlphaPricePoint | null {
  const cutoff = effectiveAt(latest) - days * DAY_MS;
  let chosen: AlphaPricePoint | null = null;
  // Ascending by date, and effectiveAt is monotonic with it for the daily
  // series this reads, so the last point at or before the cutoff is the
  // newest one -- same walk the date version did, on a real clock.
  for (const point of points) {
    if (effectiveAt(point) > cutoff) break;
    if (point.alpha_price_tao != null) chosen = point;
  }
  return chosen;
}

function changeOver(
  points: AlphaPricePoint[],
  latest: AlphaPricePoint | null,
  days: number | null | undefined,
): number | null {
  if (days == null || !latest || latest.alpha_price_tao == null) return null;
  const prior = priorPointAtLeast(points, latest, days);
  // Null, never 0, when history does not reach back far enough: "we cannot
  // measure this window" and "the price did not move" are different
  // statements, and only one of them is safe to plot.
  if (!prior || prior.alpha_price_tao == null) return null;
  return pctChange(prior.alpha_price_tao, latest.alpha_price_tao);
}

export interface AlphaPriceChanges {
  alpha_price_change_1h: null;
  alpha_price_change_1d: number | null;
  alpha_price_change_7d: number | null;
  alpha_price_change_1m: number | null;
}

/**
 * Compute the four schema fields from a daily alpha-price series.
 * Always returns all keys; missing history → null.
 */
export function computeAlphaPriceChanges(
  rows: Array<Record<string, unknown>> | null | undefined,
): AlphaPriceChanges {
  const points = normalizeAlphaPricePoints(rows);
  let latest: AlphaPricePoint | null = null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].alpha_price_tao != null) {
      latest = points[i];
      break;
    }
  }
  return {
    alpha_price_change_1h: null,
    alpha_price_change_1d: changeOver(
      points,
      latest,
      ALPHA_PRICE_CHANGE_WINDOWS["1d"],
    ),
    alpha_price_change_7d: changeOver(
      points,
      latest,
      ALPHA_PRICE_CHANGE_WINDOWS["7d"],
    ),
    alpha_price_change_1m: changeOver(
      points,
      latest,
      ALPHA_PRICE_CHANGE_WINDOWS["1m"],
    ),
  };
}

/**
 * Index snapshot rows by netuid for batch attach into economics listings.
 */
export function indexAlphaPriceHistoryByNetuid(
  rows: Array<Record<string, unknown>> | null | undefined,
): Map<
  number,
  Array<{
    snapshot_date: string;
    alpha_price_tao: unknown;
    captured_at: unknown;
  }>
> {
  const map = new Map<
    number,
    Array<{
      snapshot_date: string;
      alpha_price_tao: unknown;
      captured_at: unknown;
    }>
  >();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    const date = row.snapshot_date ?? row.date;
    if (date == null || date === "") continue;
    const list = map.get(netuid) ?? [];
    list.push({
      snapshot_date: String(date).slice(0, 10),
      alpha_price_tao: row.alpha_price_tao,
      // Carried through, or the window arithmetic downstream falls back to
      // end-of-day for every row and the fix stops working at this seam.
      captured_at: row.captured_at ?? null,
    });
    map.set(netuid, list);
  }
  return map;
}

/** Attach the four change fields onto one economics row (always present keys). */
export function withAlphaPriceChanges(
  economicsRow: Record<string, unknown> | null | undefined,
  historyRows: Array<Record<string, unknown>> | null | undefined,
): Record<string, unknown> {
  const changes = computeAlphaPriceChanges(historyRows);
  return { ...(economicsRow || {}), ...changes };
}
