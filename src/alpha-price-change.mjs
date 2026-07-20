/**
 * Derived alpha-price %-change windows for subnet economics listings (#7227).
 *
 * Source series is the same daily `subnet_snapshots.alpha_price_tao` history
 * `/api/v1/subnets/{netuid}/trajectory` already reads. Windows that lack a
 * prior finite price resolve to `null` (schema-stable) — never an error.
 *
 * `alpha_price_change_1h` is always `null` here: daily snapshots cannot
 * support an hour window (OHLC is a separate future source).
 */

export const ALPHA_PRICE_CHANGE_WINDOWS = Object.freeze({
  // 1h reserved for a future intraday source; kept for a stable schema shape.
  "1h": null,
  "1d": 1,
  "7d": 7,
  // Match trajectory's 30d window naming (1m ≈ calendar month).
  "1m": 30,
});

/** Signed percentage change start→end, rounded to 2dp. Null when undefined. */
export function pctChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) {
    return null;
  }
  return Math.round(((end - start) / start) * 100 * 100) / 100;
}

function toFiniteOrNull(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function shiftDate(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const base = Date.UTC(y, (m || 1) - 1, d || 1) + days * 24 * 60 * 60 * 1000;
  return new Date(base).toISOString().slice(0, 10);
}

/**
 * Normalize snapshot rows into ascending `{ date, alpha_price_tao }` points.
 * Accepts trajectory-shaped rows (`snapshot_date`) or already-normalized points.
 */
export function normalizeAlphaPricePoints(rows) {
  const points = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const date = row.date ?? row.snapshot_date;
    if (date == null || date === "") continue;
    points.push({
      date: String(date).slice(0, 10),
      alpha_price_tao: toFiniteOrNull(row.alpha_price_tao),
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return points;
}

/** Latest point on or before `target` with a finite alpha price. */
function finitePriceAtOrBefore(points, target) {
  let chosen = null;
  for (const point of points) {
    if (point.date > target) break;
    if (point.alpha_price_tao != null) chosen = point;
  }
  return chosen;
}

function changeOver(points, latest, days) {
  if (days == null || !latest || latest.alpha_price_tao == null) return null;
  const target = shiftDate(latest.date, -days);
  const prior = finitePriceAtOrBefore(points, target);
  if (!prior || prior.date === latest.date) return null;
  return pctChange(prior.alpha_price_tao, latest.alpha_price_tao);
}

/**
 * Compute the four schema fields from a daily alpha-price series.
 * Always returns all keys; missing history → null.
 */
export function computeAlphaPriceChanges(rows) {
  const points = normalizeAlphaPricePoints(rows);
  let latest = null;
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
 * @returns {Map<number, Array<{snapshot_date: string, alpha_price_tao: unknown}>>}
 */
export function indexAlphaPriceHistoryByNetuid(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    const date = row.snapshot_date ?? row.date;
    if (date == null || date === "") continue;
    const list = map.get(netuid) ?? [];
    list.push({
      snapshot_date: String(date).slice(0, 10),
      alpha_price_tao: row.alpha_price_tao,
    });
    map.set(netuid, list);
  }
  return map;
}

/** Attach the four change fields onto one economics row (always present keys). */
export function withAlphaPriceChanges(economicsRow, historyRows) {
  const changes = computeAlphaPriceChanges(historyRows);
  return { ...(economicsRow || {}), ...changes };
}
