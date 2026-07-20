// Derived alpha-price %-change windows for economics listing rows (#7227).
// Computed from the same daily subnet_snapshots history /trajectory reads —
// no new capture. Windows without a prior snapshot price resolve to null
// (schema-stable), matching movers pctChange + trajectory deltaOver.

export const ALPHA_PRICE_CHANGE_WINDOWS = Object.freeze({
  // Daily snapshots cannot resolve a true 1-hour lookback; the field exists
  // for schema/API stability and stays null until a sub-daily source lands.
  "1h": null,
  "1d": 1,
  "7d": 7,
  "1m": 30,
});

export const ALPHA_PRICE_CHANGE_FIELDS = Object.freeze([
  "alpha_price_change_1h",
  "alpha_price_change_1d",
  "alpha_price_change_7d",
  "alpha_price_change_1m",
]);

/** Percentage change start → end, rounded to 2dp. Null when undefined. */
export function pctChange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) {
    return null;
  }
  return Math.round(((end - start) / start) * 100 * 100) / 100;
}

function toFiniteOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shiftDate(isoDate, days) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const base = Date.UTC(y, (m || 1) - 1, d || 1) + days * 24 * 60 * 60 * 1000;
  return new Date(base).toISOString().slice(0, 10);
}

/** Latest point whose date is ≤ (latestDate − days). Points sorted ASC by date. */
export function pointAtOrBefore(points, latestDate, days) {
  const target = shiftDate(latestDate, -days);
  let chosen = null;
  for (const point of points) {
    if (String(point.date) <= target) chosen = point;
    else break;
  }
  return chosen;
}

/**
 * Normalize raw snapshot rows into ascending { date, alpha_price_tao } points.
 * Drops rows without a finite price or usable date.
 */
export function normalizePricePoints(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      date: row?.snapshot_date ?? row?.date ?? null,
      alpha_price_tao: toFiniteOrNull(row?.alpha_price_tao),
    }))
    .filter(
      (p) =>
        typeof p.date === "string" &&
        /^\d{4}-\d{2}-\d{2}/.test(p.date) &&
        p.alpha_price_tao != null,
    )
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Compute the four listing fields for one subnet.
 *
 * @param {object} opts
 * @param {number|null} opts.currentPrice live listing alpha_price_tao (preferred "now")
 * @param {Array} opts.points or opts.rows snapshot history
 * @param {string} [opts.asOfDate] YYYY-MM-DD; defaults to latest point date or UTC today
 */
export function computeAlphaPriceChanges({
  currentPrice,
  points,
  rows,
  asOfDate,
} = {}) {
  const series = points ?? normalizePricePoints(rows);
  const end = toFiniteOrNull(currentPrice);
  const latestPoint = series.length ? series[series.length - 1] : null;
  const latestDate =
    asOfDate || latestPoint?.date || new Date().toISOString().slice(0, 10);

  const out = {
    alpha_price_change_1h: null,
    alpha_price_change_1d: null,
    alpha_price_change_7d: null,
    alpha_price_change_1m: null,
  };

  if (end == null) return out;

  for (const [suffix, days] of Object.entries(ALPHA_PRICE_CHANGE_WINDOWS)) {
    const field = `alpha_price_change_${suffix}`;
    if (days == null) {
      out[field] = null;
      continue;
    }
    const cutoff = pointAtOrBefore(series, latestDate, days);
    if (!cutoff || cutoff.date === latestDate) {
      out[field] = null;
      continue;
    }
    out[field] = pctChange(cutoff.alpha_price_tao, end);
  }
  return out;
}

/** Empty (all-null) change fields — used when no history is available. */
export function emptyAlphaPriceChanges() {
  return {
    alpha_price_change_1h: null,
    alpha_price_change_1d: null,
    alpha_price_change_7d: null,
    alpha_price_change_1m: null,
  };
}

/**
 * Attach alpha_price_change_* onto each economics row.
 * `historyByNetuid` is Map<netuid, rows|points> or a plain object keyed by netuid.
 * Missing history → null fields (schema-stable).
 */
export function attachAlphaPriceChanges(rows, historyByNetuid) {
  if (!Array.isArray(rows)) return rows;
  const lookup = (netuid) => {
    if (!historyByNetuid) return null;
    if (historyByNetuid instanceof Map) return historyByNetuid.get(netuid);
    return historyByNetuid[netuid] ?? historyByNetuid[String(netuid)] ?? null;
  };
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const history = lookup(row.netuid);
    const changes = history
      ? computeAlphaPriceChanges({
          currentPrice: row.alpha_price_tao,
          rows: Array.isArray(history) ? history : undefined,
          points: Array.isArray(history?.points) ? history.points : undefined,
        })
      : emptyAlphaPriceChanges();
    return { ...row, ...changes };
  });
}

/**
 * Group flat snapshot rows `{ netuid, snapshot_date, alpha_price_tao }` into a
 * Map netuid → ascending price points.
 */
export function indexPriceHistoryByNetuid(rows) {
  const byNetuid = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const netuid = Number(row?.netuid);
    if (!Number.isInteger(netuid) || netuid < 0) continue;
    const price = toFiniteOrNull(row.alpha_price_tao);
    const date = row.snapshot_date ?? row.date;
    if (price == null || typeof date !== "string") continue;
    let list = byNetuid.get(netuid);
    if (!list) {
      list = [];
      byNetuid.set(netuid, list);
    }
    list.push({ snapshot_date: date, alpha_price_tao: price });
  }
  for (const [netuid, list] of byNetuid) {
    byNetuid.set(netuid, normalizePricePoints(list));
  }
  return byNetuid;
}

/**
 * Enrich an economics artifact blob in place-style (returns new object).
 * No-op when subnets is missing; always ensures change fields are present.
 */
export function enrichEconomicsBlob(blob, historyByNetuid) {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return blob;
  const subnets = Array.isArray(blob.subnets) ? blob.subnets : null;
  if (!subnets) return blob;
  return {
    ...blob,
    subnets: attachAlphaPriceChanges(subnets, historyByNetuid),
  };
}
