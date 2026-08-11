// #10480: make revenue movement visible, including the movement nobody
// announces.
//
// FOUR ITEM KINDS, AND ONE OF THEM IS THE POINT.
//
// A revenue surface going dark is the item this lane exists for. An operator
// can withdraw a public figure once an unflattering ratio is published, and a
// feed that silently stops is indistinguishable from a subnet that never had
// revenue -- which are very different facts. #10444 keeps the hashed
// observations so a withdrawal degrades to a dated record; this makes the
// withdrawal itself an event with a date on it.
//
// WHAT THESE ITEMS MAY NOT DO. Every kind here describes an observation and
// stops. A surface that stopped answering may have been withdrawn, may have
// moved, may be down, or may have been misconfigured by us -- so the item says
// what was read and when, names our own error as a live possibility, and never
// characterises a reason. The same rule as the burn-claim item in #10512: state
// the claim, state the observation, never assert intent.
//
// NO ITEM IS EMITTED FROM ABSENCE. A ratio move needs both endpoints priced;
// an unpriced endpoint produces no item rather than an item against a null,
// because "the ratio moved to unknown" is not a movement, it is a gap.
import type { FeedItem } from "./feeds.ts";
import { subnetPageUrl } from "./contracts.ts";
import { loadPipelineHistory } from "./emission-pipeline-history.ts";
import { loadTaoUsdSeries } from "./tao-usd-series.ts";
import type {
  RevenueObservations,
  RevenueProbeFailures,
} from "../generated/db/types.ts";

/** One row of `revenue_observations`, as the feed reads it. */
export interface RevenueObservationRow {
  surface_id: string;
  netuid: number | null;
  period: string;
  grain: string | null;
  amount: number;
  currency: string | null;
  provenance: string | null;
  observed_at: string | null;
}

/** One row of `revenue_probe_failures`. */
export interface RevenueProbeFailureRow {
  surface_id: string;
  netuid: number | null;
  reason: string | null;
  observed_at: string | null;
}

/** The denominator for one subnet on one date: measured emission in TAO, and
 * the TAO/USD price that turns it into the same unit as the revenue. Both are
 * required -- an item priced on one side would compare a dollar to a TAO. */
export interface RevenueDenominatorPoint {
  tao_total: number;
  usd_per_tao: number;
}

export interface RevenueFeedInput {
  observations: RevenueObservationRow[];
  failures: RevenueProbeFailureRow[];
  /** `${netuid}:${period}` → the priced denominator on that date. Missing
   * entries suppress the ratio item for that endpoint; they never default. */
  denominators?: Map<string, RevenueDenominatorPoint>;
  /** Items older than this are not emitted. Defaults to 30 days. */
  windowDays?: number;
  now?: number;
}

/** A coverage ratio must move by at least this fraction of its old value to be
 * an event. Set at 20% because the underlying figures are daily readings of a
 * business, and a threshold under that turns ordinary weekday/weekend variation
 * into a feed of alarms nobody reads. */
export const RATIO_MOVE_THRESHOLD = 0.2;

/** Below this many dollars, a revenue reading is not a business figure -- it is
 * a rounding artefact or a test row, and a percentage move computed against it
 * is arithmetic rather than information. */
export const REVENUE_DUST_FLOOR_USD = 1;

const DAY_MS = 86_400_000;

/** ISO, epoch-ms number, or the numeric STRING Postgres returns for a BIGINT.
 *
 * The last form is the one that matters: `observed_at` is a BIGINT, and
 * `Date.parse(String(1786320000000))` is NaN -- so a naive parse turns every
 * row in the table into an undated one and the feed goes silent while the
 * store is full. */
function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const ms = epochMs(value);
  return ms == null ? null : new Date(ms).toISOString();
}

/** A measured number, or null. Separate from Number() because Number(null) and
 * Number("") are both 0, and an unread column must never arrive as a zero. */
function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const raw = String(value);
  // A long digit run is epoch-ms, not a year: Date.parse("2026") is a valid
  // date and Date.parse("1786320000000") is not, so the digit test has to come
  // first. Mirrors src/feeds.ts's own toIso.
  if (/^-?\d{10,}$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function msOrNull(value: unknown): number | null {
  return value == null ? null : epochMs(value);
}

/** Newest first. Rows with no readable timestamp sort last rather than being
 * dropped: an undated observation is still evidence the surface answered. */
function byObservedDesc<T extends { observed_at: string | null }>(rows: T[]) {
  return [...rows].sort(
    (a, b) => (msOrNull(b.observed_at) ?? -1) - (msOrNull(a.observed_at) ?? -1),
  );
}

function usd(amount: number): string {
  return amount >= 1000
    ? `$${Math.round(amount).toLocaleString("en-US")}`
    : `$${amount.toFixed(2)}`;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** A named subnet reads better than a netuid, but the feed has no name source
 * that is guaranteed present, so the netuid is the identifier and the name is
 * never guessed. */
function subnetLabel(netuid: number | null): string {
  return netuid == null ? "an unattributed surface" : `Subnet ${netuid}`;
}

/**
 * The revenue feed's items.
 *
 * Pure over rows that have already been read, so the item wording -- the part
 * with the blast radius -- is testable without a store.
 */
export function revenueFeedItems(input: RevenueFeedInput): FeedItem[] {
  const { denominators } = input;
  const now = input.now ?? Date.now();
  const cutoff = now - (input.windowDays ?? 30) * DAY_MS;
  const items: FeedItem[] = [];

  const bySurface = new Map<string, RevenueObservationRow[]>();
  for (const row of input.observations) {
    if (!row.surface_id) continue;
    const list = bySurface.get(row.surface_id) ?? [];
    list.push(row);
    bySurface.set(row.surface_id, list);
  }

  const failuresBySurface = new Map<string, RevenueProbeFailureRow[]>();
  for (const row of input.failures) {
    if (!row.surface_id) continue;
    const list = failuresBySurface.get(row.surface_id) ?? [];
    list.push(row);
    failuresBySurface.set(row.surface_id, list);
  }

  // ── surfaces that went dark ────────────────────────────────────────────────
  //
  // A surface is dark when its newest probe FAILED and no observation is newer.
  // Ordering by timestamp rather than counting failures matters: a surface that
  // failed once, recovered, and is answering again is not dark, and reporting
  // it as such would put a withdrawal notice on a working endpoint.
  for (const [surfaceId, failures] of failuresBySurface) {
    const newestFailure = byObservedDesc(failures)[0];
    const failedAt = msOrNull(newestFailure?.observed_at);
    if (failedAt == null || failedAt < cutoff) continue;
    const observations = byObservedDesc(bySurface.get(surfaceId) ?? []);
    const lastGood = observations[0];
    const lastGoodAt = msOrNull(lastGood?.observed_at);
    if (lastGoodAt != null && lastGoodAt >= failedAt) continue;
    // A surface that has NEVER answered is not a withdrawal, it is a surface
    // that never worked. Both are worth knowing and they are not the same
    // event, so they carry different wording and different tags.
    const netuid = newestFailure.netuid ?? lastGood?.netuid ?? null;
    const when = new Date(failedAt).toISOString();
    if (!lastGood) {
      items.push({
        id: `revenue-surface-unreadable:${surfaceId}:${when}`,
        url: subnetPageUrl(netuid),
        title: `${subnetLabel(netuid)} — declared revenue surface has not returned a readable figure`,
        summary:
          `The revenue surface \`${surfaceId}\` is declared for ${subnetLabel(netuid).toLowerCase()} but has never returned a figure this lane could read. ` +
          `The most recent attempt failed on ${when}. This is a statement about what we could read, not about whether the subnet earns anything: ` +
          `a surface can be auth-gated, shaped differently than we expect, or misconfigured on our side.`,
        timestamp: when,
        tags: ["revenue", "surface-unreadable"],
      });
      continue;
    }
    const lastAmount = Number(lastGood.amount);
    items.push({
      id: `revenue-surface-dark:${surfaceId}:${when}`,
      url: subnetPageUrl(netuid),
      title: `${subnetLabel(netuid)} — revenue surface stopped returning a figure`,
      summary:
        `The revenue surface \`${surfaceId}\` last returned a readable figure on ${lastGood.observed_at ?? "an unrecorded date"}` +
        `${Number.isFinite(lastAmount) ? ` (${usd(lastAmount)} for period ${lastGood.period})` : ""}, ` +
        `and the probe has failed since ${when}. ` +
        `A feed that stops is not a subnet that stopped earning, and this item asserts nothing about why: the endpoint may have moved, may be down, ` +
        `may have been withdrawn, or may be misread by us. The prior observations are retained and dated so the record does not vanish with the feed.`,
      timestamp: when,
      tags: ["revenue", "surface-dark"],
    });
  }

  for (const [surfaceId, rows] of bySurface) {
    const ordered = byObservedDesc(rows);

    // ── newly discovered ────────────────────────────────────────────────────
    //
    // First observation inside the window. Keyed on the OLDEST reading rather
    // than a discovery flag, because there is no discovery event to read: the
    // lane either has history for a surface or it does not.
    const firstAt = msOrNull(ordered[ordered.length - 1]?.observed_at);
    if (firstAt != null && firstAt >= cutoff) {
      const first = ordered[ordered.length - 1];
      const when = new Date(firstAt).toISOString();
      items.push({
        id: `revenue-surface-new:${surfaceId}:${when}`,
        url: subnetPageUrl(first.netuid ?? null),
        title: `${subnetLabel(first.netuid ?? null)} — revenue surface now returning readable figures`,
        summary:
          `\`${surfaceId}\` returned its first readable figure on ${when}: ${usd(Number(first.amount))} for period ${first.period}` +
          `${first.grain ? ` (${first.grain})` : ""}. ` +
          `Provenance is \`${first.provenance ?? "unrecorded"}\`. A newly readable surface changes what we can say about this subnet, not what the subnet did.`,
        timestamp: when,
        tags: ["revenue", "surface-new"],
      });
    }

    // ── provenance changed ──────────────────────────────────────────────────
    //
    // Reported in both directions. An upgrade is the good news; a downgrade
    // (probe-derived back to operator-attested) weakens every figure derived
    // from the surface and is exactly the change a reader must not miss because
    // only improvements were published.
    const withProvenance = ordered.filter((r) => r.provenance);
    for (let i = 0; i < withProvenance.length - 1; i += 1) {
      const newer = withProvenance[i];
      const older = withProvenance[i + 1];
      if (newer.provenance === older.provenance) continue;
      const at = msOrNull(newer.observed_at);
      if (at == null || at < cutoff) continue;
      const when = new Date(at).toISOString();
      items.push({
        id: `revenue-provenance:${surfaceId}:${when}`,
        url: subnetPageUrl(newer.netuid ?? null),
        title: `${subnetLabel(newer.netuid ?? null)} — revenue provenance changed to ${newer.provenance}`,
        summary:
          `\`${surfaceId}\` moved from \`${older.provenance}\` to \`${newer.provenance}\` on ${when}. ` +
          `Provenance decides whether a figure reaches the headline ratio at all: only chain-verified and probe-derived readings do. ` +
          `A change in either direction changes what the published number is defensible as.`,
        timestamp: when,
        tags: ["revenue", "provenance"],
      });
      break; // one item per surface per window: the newest change is the news
    }

    // ── material coverage-ratio move ────────────────────────────────────────
    //
    // Both endpoints must be priced. An unpriced endpoint yields NO item --
    // "the ratio moved to unknown" is a gap, not a movement, and publishing it
    // as one would put a number-shaped event on an absence.
    const periods = [...rows]
      .filter((r) => r.period && Number.isFinite(Number(r.amount)))
      .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
    if (periods.length >= 2 && denominators) {
      const [newest, previous] = periods;
      const key = (row: RevenueObservationRow) =>
        `${row.netuid ?? ""}:${row.period}`;
      const dNew = denominators.get(key(newest));
      const dOld = denominators.get(key(previous));
      const at = msOrNull(newest.observed_at);
      if (dNew && dOld && at != null && at >= cutoff) {
        const emissionNew = dNew.tao_total * dNew.usd_per_tao;
        const emissionOld = dOld.tao_total * dOld.usd_per_tao;
        const amountNew = Number(newest.amount);
        const amountOld = Number(previous.amount);
        // A zero denominator is not a ratio of infinity, it is a subnet that
        // received no emission that day -- which the coverage ratio has no
        // defined value for and must not report one.
        if (
          emissionNew > 0 &&
          emissionOld > 0 &&
          amountOld >= REVENUE_DUST_FLOOR_USD
        ) {
          const ratioNew = amountNew / emissionNew;
          const ratioOld = amountOld / emissionOld;
          const move = (ratioNew - ratioOld) / ratioOld;
          if (Math.abs(move) >= RATIO_MOVE_THRESHOLD) {
            const when = new Date(at).toISOString();
            const direction = move > 0 ? "rose" : "fell";
            items.push({
              id: `revenue-coverage-move:${surfaceId}:${newest.period}`,
              url: subnetPageUrl(newest.netuid ?? null),
              title: `${subnetLabel(newest.netuid ?? null)} — coverage ratio ${direction} to ${pct(ratioNew)}`,
              summary:
                `Coverage ratio ${direction} from ${pct(ratioOld)} (${previous.period}) to ${pct(ratioNew)} (${newest.period}), ` +
                `on observed revenue of ${usd(amountOld)} → ${usd(amountNew)} against emission of ${usd(emissionOld)} → ${usd(emissionNew)}. ` +
                `Both sides move: a ratio change can come from revenue, from emission, or from the TAO price, and this item does not attribute it to any of them. ` +
                `A high subsidy multiple is not an accusation and a low one is not a badge.`,
              timestamp: when,
              tags: ["revenue", "coverage-move"],
            });
          }
        }
      }
    }
  }

  return items;
}

// ── the store read ──────────────────────────────────────────────────────────

/** The minimal handle these three reads need. Injected rather than imported so
 * the loader is testable without a Worker binding, matching every other loader
 * in this repo. */
export interface RevenueFeedDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
  };
}

// Deliberately loose for the SHAPING helpers below, which read rows from two
// different drivers. The two revenue tables are typed from the live schema
// instead -- see RevenueObservations/RevenueProbeFailures at the read sites,
// where `observed_at: number | string` is the honest BIGINT type and the reason
// epochMs exists at all.
type Row = Record<string, unknown>;

/** Bounded so one pathological surface cannot make the feed read the table. The
 * feed caps at FEED_MAX_ITEMS anyway; this bounds the SCAN, not the output. */
const FEED_ROW_LIMIT = 2000;

/** How far back the denominator legs are read. Matches the feed window: a
 * denominator older than the oldest item it could price is dead weight. */
const DENOMINATOR_WINDOW = "30d";
const DENOMINATOR_WINDOW_HOURS = 24 * 30;

// GENERIC over the row the SELECT returns, so the caller names the generated
// table type once instead of casting the result. The assertion below is the
// D1 trust boundary -- `all()` answers `unknown` and only the SQL knows the
// shape -- and it is now in one place rather than at every call site (#10782).
async function queryRows<T = Row>(
  db: RevenueFeedDb | null | undefined,
  sql: string,
  binds: unknown[],
): Promise<T[] | null> {
  if (!db?.prepare) return null;
  try {
    const statement = db.prepare(sql);
    const res = await (
      binds.length ? statement.bind(...binds) : statement
    ).all?.();
    return (res?.results ?? []) as T[];
  } catch {
    // Null, not []: a failed read and an empty table are different facts, and
    // an empty feed derived from a broken store would read as "nothing moved".
    return null;
  }
}

/** epoch-ms or ISO → the UTC calendar date the denominator is keyed by. */
function utcDate(value: unknown): string | null {
  const ms = epochMs(value);
  return ms == null ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Read the feed's inputs and build its items.
 *
 * ONE STORE HANDLE, AND THE TABLE SET IS DECLARED. readStore is all-or-nothing
 * over the set it is given, so the four tables this reads --
 * revenue_observations, revenue_probe_failures, subnet_snapshots and
 * tao_usd_index -- are declared together in REVENUE_FEED_TABLES and checked
 * against the SQL below by tests/read-store-tables-match-the-sql.test.ts. All
 * four are Neon sole-store, so splitting them across handles would buy no
 * availability and would cost that check: an under-declared set does not read
 * less, it routes the loader to Neon on the tables it DID name and resolves the
 * rest against a store that does not have them.
 */
export async function loadRevenueFeedItems(
  db: RevenueFeedDb | null | undefined,
  options: { windowDays?: number; now?: number } = {},
): Promise<FeedItem[]> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? 30;
  const cutoff = now - windowDays * DAY_MS;

  const [observationRows, failureRows] = await Promise.all([
    queryRows<RevenueObservations>(
      db,
      `SELECT surface_id, netuid, period, grain, amount, currency, provenance, observed_at` +
        ` FROM revenue_observations ORDER BY observed_at DESC LIMIT ${FEED_ROW_LIMIT}`,
      [],
    ),
    queryRows<RevenueProbeFailures>(
      db,
      `SELECT surface_id, netuid, reason, observed_at` +
        ` FROM revenue_probe_failures WHERE observed_at >= ?` +
        ` ORDER BY observed_at DESC LIMIT ${FEED_ROW_LIMIT}`,
      [cutoff],
    ),
  ]);
  if (observationRows === null && failureRows === null) return [];

  const observations: RevenueObservationRow[] = (observationRows ?? []).map(
    (r) => ({
      surface_id: String(r.surface_id ?? ""),
      netuid: r.netuid == null ? null : Number(r.netuid),
      period: String(r.period ?? ""),
      grain: r.grain == null ? null : String(r.grain),
      amount: Number(r.amount),
      currency: r.currency == null ? null : String(r.currency),
      provenance: r.provenance == null ? null : String(r.provenance),
      observed_at: isoOrNull(r.observed_at),
    }),
  );
  const failures: RevenueProbeFailureRow[] = (failureRows ?? []).map((r) => ({
    surface_id: String(r.surface_id ?? ""),
    netuid: r.netuid == null ? null : Number(r.netuid),
    reason: r.reason == null ? null : String(r.reason),
    observed_at: isoOrNull(r.observed_at),
  }));

  return revenueFeedItems({
    observations,
    failures,
    denominators: await loadDenominators(db, observations, now),
    windowDays,
    now,
  });
}

/**
 * The priced denominator for every (netuid, period) the observations name.
 *
 * READS THROUGH THE TWO LOADERS THAT ALREADY OWN THESE TABLES rather than
 * writing a third copy of their SQL. `subnet_snapshots` is
 * emission-pipeline-history's and `tao_usd_index` is tao-usd-series'; a second
 * spelling of either would be one more thing that can disagree with the route
 * serving the same figures.
 *
 * Returns undefined -- not an empty map -- when either leg is unreadable, so
 * revenueFeedItems suppresses the ratio items rather than emitting them against
 * denominators it could not find. An empty map would look like "no subnet had
 * emission", which is a claim; undefined is the absence of one.
 */
async function loadDenominators(
  db: RevenueFeedDb | null | undefined,
  observations: RevenueObservationRow[],
  nowMs: number,
): Promise<Map<string, RevenueDenominatorPoint> | undefined> {
  const netuids = [
    ...new Set(
      observations
        .map((o) => o.netuid)
        .filter((n): n is number => Number.isInteger(n)),
    ),
  ];
  if (netuids.length === 0) return undefined;

  const [series, priceRows] = await Promise.all([
    Promise.all(
      netuids.map(async (netuid) => ({
        netuid,
        rows: await loadPipelineHistory(db, netuid, {
          window: DENOMINATOR_WINDOW,
          nowMs,
        }),
      })),
    ),
    loadTaoUsdSeries(db, { windowHours: DENOMINATOR_WINDOW_HOURS }),
  ]);
  // A null from either loader is a FAILED read, not an empty one. Building a
  // map from it would price some endpoints and silently drop others.
  //
  // Narrowed by construction rather than by a `.some()` guard: a predicate
  // cannot narrow the array's element type, so the loop below would still need
  // a `?? []` for a case this already excluded -- an unreachable fallback that
  // reads like a real one.
  if (priceRows === null) return undefined;
  const readSeries: { netuid: number; rows: Row[] }[] = [];
  for (const entry of series) {
    if (entry.rows === null) return undefined;
    readSeries.push({ netuid: entry.netuid, rows: entry.rows as Row[] });
  }

  // One price per UTC day: the FIRST row for a day wins, and the series arrives
  // newest first, so that is the latest reading of that day rather than an
  // average. An average is a price nobody observed.
  const priceByDate = new Map<string, number>();
  for (const r of priceRows) {
    const date = utcDate((r as Row).observed_at);
    const price = numberOrNull((r as Row).usd_per_tao);
    if (!date || price === null || price <= 0) continue;
    if (!priceByDate.has(date)) priceByDate.set(date, price);
  }

  const out = new Map<string, RevenueDenominatorPoint>();
  for (const { netuid, rows } of readSeries) {
    for (const r of rows) {
      const date = String(r.snapshot_date ?? "").slice(0, 10);
      const price = priceByDate.get(date);
      if (price == null) continue;
      // tao_total is the measured pair, both legs required. A missing excess is
      // not a zero excess -- it is an unread column, and summing it as zero
      // would understate the denominator and overstate every ratio on it.
      //
      // The null check is separate from the finite check ON PURPOSE:
      // Number(null) is 0, not NaN, so a finite test alone accepts an unread
      // column as a measured zero -- the exact conflation this guard stops.
      const inEmission = numberOrNull(r.tao_in_emission_tao);
      const excess = numberOrNull(r.excess_tao);
      if (inEmission === null || excess === null) continue;
      out.set(`${netuid}:${date}`, {
        tao_total: inEmission + excess,
        usd_per_tao: price,
      });
    }
  }
  return out;
}
