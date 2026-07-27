// GET /api/v1/self-health (metagraphed#8318) -- metagraphed's OWN uptime.
//
// Every other health surface this API serves is about someone else:
// /api/v1/health rolls up probed SUBNET surfaces, /api/v1/incidents covers
// public RPC endpoints. So /status could only ever answer "are the things we
// watch up", never "are WE up" -- which is the question a visitor on a status
// page is actually asking, and the one it looked like it was answering.
//
// Fed by the poller's self-health job (metagraphed#8317), which probes from
// the indexer box rather than from a Worker: a Worker checking
// Cloudflare-hosted routes shares a failure domain with what it's checking,
// and would report green through exactly the outage a reader cares about.
//
// THE VERDICT IS SCOPED TO OUR OWN COMPONENTS, deliberately. It never mixes in
// third-party subnet-surface health -- a subnet's API being down says nothing
// about whether metagraphed is up, and conflating the two is precisely what
// made the old /status verdict unreadable (metagraphed#8250).

/** The components the poller writes. Order is display order. */
export const SELF_HEALTH_COMPONENTS = ["api", "site", "publish"] as const;
export type SelfHealthComponent = (typeof SELF_HEALTH_COMPONENTS)[number];

/** One row of the 90-day rollup.
 *
 * `day` is DATE in Postgres (generated as `Date` by Kanel), but the route
 * selects it as `day::text` so it arrives as a plain YYYY-MM-DD string -- a
 * Date object here would serialize with a spurious time component and a
 * timezone the column never carried.
 */
export interface SelfHealthDailyRow {
  day: string;
  component: string;
  checks: number;
  ok_count: number;
}

/** Latest raw tick per component, for current state.
 *
 * `checked_at_ms` is BIGINT in Postgres, and postgres.js hands BIGINT back as
 * a STRING (this Worker runs with `fetch_types: false`) -- hence the union and
 * the coercion below. Typing it as a bare number and comparing directly would
 * do a lexicographic compare on the newest-tick pick and silently null out
 * every timestamp in `toIso`, since Number.isFinite("1785...") is false.
 * Confirmed against the generated row type (generated/db/public/SelfHealthChecks.ts,
 * `checked_at_ms: string & {...}`) and the existing BIGINT fixtures in
 * tests/data-api.test.ts (`block_number: "123"`).
 */
export interface SelfHealthLatestRow {
  component: string;
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
  checked_at_ms: number | string;
}

/** BIGINT-as-string tolerant numeric coercion. NaN for anything unusable, so
 * the callers' own Number.isFinite guards stay meaningful. */
function toMs(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

export interface SelfHealthDay {
  day: string;
  checks: number;
  ok_count: number;
  /** ok_count / checks, 0..1. */
  uptime_ratio: number;
}

export interface SelfHealthComponentView {
  component: string;
  /** Null when the component has never been probed -- NOT false. */
  current_ok: boolean | null;
  http_status: number | null;
  latency_ms: number | null;
  checked_at: string | null;
  /**
   * Trailing-90d daily ratios, oldest first. Days with no rows are ABSENT,
   * not zero-filled: a gap means "we weren't measuring", and rendering that
   * as 0% uptime would invent an outage that never happened. The house rule
   * is probe-derived only, never synthesized.
   */
  days: SelfHealthDay[];
  /** Mean uptime across the days we actually have. Null when there are none. */
  uptime_90d: number | null;
}

export type SelfHealthVerdict = "operational" | "degraded" | "outage";

export interface SelfHealth {
  schema_version: number;
  verdict: SelfHealthVerdict;
  components: SelfHealthComponentView[];
  /** Components with data. Zero means the poller hasn't written anything yet. */
  measured_component_count: number;
  observed_at: string | null;
}

/**
 * `api` is the load-bearing component: if it's down the site has nothing to
 * render and every client is broken, so it alone decides an outage. `site` and
 * `publish` failing are real problems that don't stop the API answering, so
 * they degrade rather than outage.
 *
 * A component with no data at all is NOT counted as failing -- "we haven't
 * measured this yet" and "this is down" are different claims, and only one of
 * them is ours to make.
 */
export function selfHealthVerdict(
  components: SelfHealthComponentView[],
): SelfHealthVerdict {
  const measured = components.filter((c) => c.current_ok !== null);
  // Nothing measured yet: not an outage, and not a claim of health either.
  // "degraded" is the honest floor -- we can't assert we're operational
  // without evidence.
  if (measured.length === 0) return "degraded";
  const api = measured.find((c) => c.component === "api");
  if (api && !api.current_ok) return "outage";
  if (measured.some((c) => !c.current_ok)) return "degraded";
  return "operational";
}

function toIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Mean of the daily ratios we have. Unweighted by check count on purpose: a
 * day the poller only ran twice shouldn't count 30x less than a full day, and
 * check-count weighting would quietly hide a short outage on a sparse day. */
function meanRatio(days: SelfHealthDay[]): number | null {
  if (days.length === 0) return null;
  const sum = days.reduce((acc, d) => acc + d.uptime_ratio, 0);
  return sum / days.length;
}

/**
 * Assembles the response from the two tables' rows.
 *
 * Both inputs are taken as already-filtered lists (the SQL does the 90-day
 * window and the per-component latest-tick pick) so this stays a pure
 * transform that a test can drive without a database.
 */
export function buildSelfHealth(
  dailyRows: SelfHealthDailyRow[],
  latestRows: SelfHealthLatestRow[],
): SelfHealth {
  const byComponent = new Map<string, SelfHealthDailyRow[]>();
  for (const row of dailyRows) {
    const list = byComponent.get(row.component);
    if (list) list.push(row);
    else byComponent.set(row.component, [row]);
  }

  const latestByComponent = new Map<string, SelfHealthLatestRow>();
  for (const row of latestRows) {
    const existing = latestByComponent.get(row.component);
    if (!existing || toMs(row.checked_at_ms) > toMs(existing.checked_at_ms)) {
      latestByComponent.set(row.component, row);
    }
  }

  const components: SelfHealthComponentView[] = SELF_HEALTH_COMPONENTS.map(
    (component) => {
      const days: SelfHealthDay[] = (byComponent.get(component) ?? [])
        .filter((r) => r.checks > 0)
        .map((r) => ({
          day: r.day,
          checks: r.checks,
          ok_count: r.ok_count,
          uptime_ratio: r.ok_count / r.checks,
        }))
        .sort((a, b) => a.day.localeCompare(b.day));
      const latest = latestByComponent.get(component);
      return {
        component,
        current_ok: latest ? latest.ok : null,
        http_status: latest?.http_status ?? null,
        latency_ms: latest?.latency_ms ?? null,
        checked_at: latest ? toIso(toMs(latest.checked_at_ms)) : null,
        days,
        uptime_90d: meanRatio(days),
      };
    },
  );

  const observedMs = latestRows.reduce<number | null>((max, r) => {
    const ms = toMs(r.checked_at_ms);
    if (!Number.isFinite(ms)) return max;
    return max == null || ms > max ? ms : max;
  }, null);

  return {
    schema_version: 1,
    verdict: selfHealthVerdict(components),
    components,
    measured_component_count: components.filter((c) => c.current_ok !== null)
      .length,
    observed_at: toIso(observedMs),
  };
}
