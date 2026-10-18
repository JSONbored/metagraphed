// #11550: estimated composition of the observed price set, never certified
// runtime eligibility or final emissions. No history is synthesized on read.
import {
  PRICE_SHARE_COMPOSITION_DAYS,
  PRICE_SHARE_COMPOSITION_SERIES,
  PRICE_SHARE_COMPOSITION_ROWS,
} from "./route-limits.ts";
import type { SubnetPriceShareCompositionArtifact } from "../schemas-src/routes/subnet-price-share-composition.ts";
import type { OptionalRowQuerier } from "./read-store.ts";

type Row = Record<string, unknown>;

const UNIT = 1_000_000;
const DAY_MS = 86_400_000;
export const PRICE_SHARE_COMPOSITION_TABLE = "subnet_snapshots";
// Same-direction ordering uses the existing (snapshot_date, netuid) index in
// reverse. No expression, JOIN, aggregation, OFFSET or per-netuid fanout.
export const PRICE_SHARE_COMPOSITION_SQL =
  `SELECT netuid, snapshot_date, captured_at, emission_share` +
  ` FROM ${PRICE_SHARE_COMPOSITION_TABLE}` +
  ` WHERE snapshot_date >= ? AND snapshot_date < ?` +
  ` ORDER BY snapshot_date DESC, netuid DESC LIMIT ?`;

/** One bounded read, including one sentinel to detect a truncated raw date. */
export async function loadSubnetPriceShareComposition(
  db: OptionalRowQuerier | null | undefined,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): Promise<Row[] | null> {
  if (!db?.query) return null;
  const today = Date.parse(new Date(nowMs).toISOString().slice(0, 10));
  try {
    return await db.query<Row>(PRICE_SHARE_COMPOSITION_SQL, [
      new Date(today - PRICE_SHARE_COMPOSITION_DAYS * DAY_MS)
        .toISOString()
        .slice(0, 10),
      new Date(today).toISOString().slice(0, 10),
      PRICE_SHARE_COMPOSITION_ROWS + 1,
    ]);
  } catch {
    return null;
  }
}

/** The writer rounds to six decimals. Accept only its representable grid. */
function shareUnits(value: unknown): number | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    return null;
  const scaled = value * UNIT;
  const rounded = Math.round(scaled);
  return value === rounded / UNIT ? rounded : null;
}

interface Day {
  day: string;
  captured_at: number;
  shares: Map<number, number>;
}

function eligibleDay(day: string, rows: Row[], nowMs: number): Day | null {
  const seen = new Set<number>();
  const shares = new Map<number, number>();
  let captured: number | null = null;
  let total = 0;
  for (const row of rows) {
    const netuid = row.netuid;
    if (
      typeof netuid !== "number" ||
      !Number.isInteger(netuid) ||
      netuid < 0 ||
      netuid > 65535 ||
      seen.has(netuid)
    )
      return null;
    seen.add(netuid);
    // An unpriced row is outside the observed numeric set. It cannot enter
    // the cohort or supply a zero for a selected netuid on another day.
    if (row.emission_share === null) continue;
    const units = shareUnits(row.emission_share);
    const timestamp = row.captured_at;
    if (
      units === null ||
      typeof timestamp !== "number" ||
      !Number.isSafeInteger(timestamp) ||
      timestamp <= 0 ||
      timestamp > nowMs
    )
      return null;
    if (captured !== null && captured !== timestamp) return null;
    captured = timestamp;
    shares.set(netuid, units);
    total += units;
  }
  // Each independently rounded six-decimal share contributes at most half
  // a micro-unit of error. This detects partial normalization, not missing
  // zero-price rows or a source pass's identity/completeness.
  if (captured === null || Math.abs(total - UNIT) * 2 > shares.size) return null;
  return { day, captured_at: captured, shares };
}

export function buildSubnetPriceShareComposition(
  rows: Row[] | null,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): SubnetPriceShareCompositionArtifact {
  const result: SubnetPriceShareCompositionArtifact = {
    schema_version: 1,
    quality: "estimated_observed_price_set",
    window_days: PRICE_SHARE_COMPOSITION_DAYS,
    cohort_limit: PRICE_SHARE_COMPOSITION_SERIES,
    row_limit: PRICE_SHARE_COMPOSITION_ROWS,
    other_label: "Other artifact-normalized price share",
    series: [],
    point_count: rows === null ? null : 0,
    oldest_day: null,
    newest_day: null,
    points: [],
  };
  if (rows === null) {
    result.degraded = { reason: "unavailable" };
    return result;
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const firstDay = new Date(
    Date.parse(today) - PRICE_SHARE_COMPOSITION_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const bounded = rows.slice(0, PRICE_SHARE_COMPOSITION_ROWS);
  const boundary =
    rows.length > PRICE_SHARE_COMPOSITION_ROWS &&
    bounded[bounded.length - 1].snapshot_date ===
      rows[PRICE_SHARE_COMPOSITION_ROWS].snapshot_date
      ? rows[PRICE_SHARE_COMPOSITION_ROWS].snapshot_date
      : null;
  const grouped = new Map<string, Row[]>();
  for (const row of bounded) {
    const day = row.snapshot_date;
    if (
      typeof day !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !Number.isFinite(Date.parse(day)) ||
      new Date(day).toISOString().slice(0, 10) !== day ||
      day < firstDay ||
      day >= today ||
      day === boundary
    )
      continue;
    const group = grouped.get(day) ?? [];
    group.push(row);
    grouped.set(day, group);
  }
  const days: Day[] = [];
  for (const day of [...grouped.keys()].sort().reverse()) {
    const eligible = eligibleDay(day, grouped.get(day)!, nowMs);
    if (eligible !== null) days.push(eligible);
  }
  if (days.length === 0) return result;
  // Eligibility above describes the raw observed set. The fixed selected
  // total is checked separately below; rounding can make its date unrenderable
  // without changing which newest eligible date owns the cohort.
  const cohort = [...days[0].shares.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, PRICE_SHARE_COMPOSITION_SERIES)
    .map(([netuid]) => netuid);
  result.series = cohort.map((netuid) => ({ netuid }));
  for (const day of days.reverse()) {
    if (!cohort.every((netuid) => day.shares.has(netuid))) continue;
    const units = cohort.map((netuid) => day.shares.get(netuid)!);
    const total = units.reduce((sum, value) => sum + value, 0);
    if (total > UNIT) continue;
    result.points.push({
      day: day.day,
      captured_at: new Date(day.captured_at).toISOString(),
      shares: units.map((value) => value / UNIT),
      other_share: (UNIT - total) / UNIT,
    });
  }
  result.point_count = result.points.length;
  result.oldest_day = result.points[0]?.day ?? null;
  result.newest_day = result.points.at(-1)?.day ?? null;
  return result;
}
