/**
 * The derivations behind /subnets (#11613).
 *
 * Pure, API-shaped in and view-shaped out, so the four sections stay
 * declarative and the arithmetic that decides a ranking is testable.
 */
import type {
  Subnet,
  SubnetEconomics,
  SubnetLifecycleEntry,
  SubnetMover,
} from "@/lib/metagraphed/types";
import { formatCompactAmount, formatDecimal, formatPct } from "@/lib/metagraphed/format";

export type RankMetric = "emission" | "stake" | "price" | "validators";
export type RankWindow = "7d" | "30d" | "90d";

export const METRIC_OPTIONS = [
  { value: "emission", label: "Emission" },
  { value: "price", label: "Price" },
  { value: "validators", label: "Validators" },
] as const;

/**
 * The windows each metric can actually answer for.
 *
 * Price change comes from the economics snapshot, which publishes a 7-day and
 * a 1-month reading and nothing longer; the movers endpoint covers all three.
 * A control offering a window the metric cannot serve is a control that
 * silently does nothing.
 */
export function windowsFor(metric: RankMetric): { value: RankWindow; label: string }[] {
  const all: { value: RankWindow; label: string }[] = [
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "90d", label: "90d" },
  ];
  return metric === "price" ? all.slice(0, 2) : all;
}

/** Clamps a window to one the metric can serve. */
export function resolveWindow(metric: RankMetric, window: RankWindow): RankWindow {
  const allowed = windowsFor(metric).map((option) => option.value);
  return allowed.includes(window) ? window : allowed[allowed.length - 1]!;
}

export interface RankedSubnet {
  netuid: number;
  name: string;
  /** The metric's current reading, already formatted. */
  value: string;
  /** Fractional change over the window, or "new" for a first appearance. */
  delta: number | "new" | undefined;
  domain?: string;
}

/**
 * A percentage field → the fraction every renderer here expects.
 *
 * `/api/v1/economics` and `/subnets/movers` both publish CHANGE as a
 * percentage (`alpha_price_change_7d: -2.3` means −2.3%, and the live range
 * is −100 … +334), while `emission_share` on the same row is a fraction.
 * Two units on one object is exactly the trap that renders a −2.3% move as
 * −230%, so the conversion happens ONCE, here, at the boundary — nothing
 * downstream of this module handles a percentage.
 */
const pctToFraction = (pct: number | null | undefined): number | undefined =>
  typeof pct === "number" && Number.isFinite(pct) ? pct / 100 : undefined;

export const fmtAlpha = (value: number | null | undefined): string => formatCompactAmount(value);

export const fmtPct = (fraction: number | null | undefined, places = 2): string =>
  formatPct(fraction, places);

/** Which movers sort dimension a metric ranks along. */
export const MOVERS_SORT: Record<Exclude<RankMetric, "price">, string> = {
  emission: "emission",
  stake: "stake",
  validators: "validators",
};

/** `/subnets/movers` rejects a limit above this. */
export const MOVERS_LIMIT = 100;

/**
 * The ranking for one metric and window.
 *
 * The LEVEL comes from the economics snapshot and the CHANGE comes from
 * `/subnets/movers`, because the two answer different questions and only one
 * of them covers every subnet. `movers` ranks by change and serves at most
 * 100 rows of 129, so ranking off it would quietly exclude a large subnet
 * that simply did not move — which is the opposite of "the subnets that carry
 * the network". A subnet outside the movers slice keeps its row and shows no
 * delta, which is the honest rendering of "we did not measure its change".
 *
 * Price is the exception and ranks by its change: an alpha price is a price
 * per subnet token, so one subnet's 0.5τ is not comparable to another's, and
 * the level carries no ranking information at all.
 */
export function rankSubnets(
  metric: RankMetric,
  window: RankWindow,
  movers: readonly SubnetMover[],
  economics: readonly SubnetEconomics[],
  nameOf: (netuid: number) => string,
  domainOf: (netuid: number) => string | undefined,
  limit = 18,
): RankedSubnet[] {
  // The legacy economics stake field originates in metagraph voting weights,
  // mixing inherited alpha and weighted root TAO. It is not token holdings.
  // Keep old metric=stake URLs safe until a certified valuation is available.
  if (metric === "stake") return [];

  const change = new Map<number, number | "new" | undefined>();
  for (const mover of movers) {
    if (metric === "emission") change.set(mover.netuid, pctToFraction(mover.emission_pct_change));
    else if (metric === "validators") {
      change.set(
        mover.netuid,
        mover.validators_start > 0
          ? mover.validators_delta / mover.validators_start
          : mover.validators_delta > 0
            ? "new"
            : undefined,
      );
    }
  }

  const rows: { netuid: number; sort: number; value: string; delta: number | "new" | undefined }[] =
    [];
  for (const row of economics) {
    if (metric === "price") {
      const price = row.alpha_price_tao;
      const moved = pctToFraction(
        window === "7d" ? row.alpha_price_change_7d : row.alpha_price_change_1m,
      );
      if (typeof price !== "number" || !Number.isFinite(price)) continue;
      if (moved === undefined) continue;
      rows.push({
        netuid: row.netuid,
        sort: moved,
        value: `${formatDecimal(price, 4)}τ`,
        delta: moved,
      });
      continue;
    }
    if (metric === "emission") {
      const share = row.emission_share;
      if (typeof share !== "number" || !Number.isFinite(share)) continue;
      rows.push({
        netuid: row.netuid,
        sort: share,
        value: fmtPct(share, 3),
        delta: change.get(row.netuid),
      });
      continue;
    }
    const validators = row.validator_count;
    if (typeof validators !== "number" || !Number.isFinite(validators)) continue;
    rows.push({
      netuid: row.netuid,
      sort: validators,
      value: String(validators),
      delta: change.get(row.netuid),
    });
  }

  return rows
    .sort((a, b) => b.sort - a.sort)
    .slice(0, limit)
    .map((row) => ({
      netuid: row.netuid,
      name: nameOf(row.netuid),
      value: row.value,
      delta: row.delta,
      domain: domainOf(row.netuid),
    }));
}

export interface ChurnColumn {
  key: string;
  label: string;
  axisLabel: string;
  total: number;
  segments: { key: string; label: string; value: number }[];
}

/**
 * Lifecycle events bucketed by day.
 *
 * By DAY, not by week: `/chain/subnet-lifecycle` serves the whole captured
 * history and that history is under a fortnight deep, so weekly buckets would
 * draw two columns and call it a trend.
 */
export function churnByDay(entries: readonly SubnetLifecycleEntry[]): ChurnColumn[] {
  const byDay = new Map<string, { registered: number; deregistered: number }>();
  for (const entry of entries) {
    if (!entry.observed_at) continue;
    const day = entry.observed_at.slice(0, 10);
    const bucket = byDay.get(day) ?? { registered: 0, deregistered: 0 };
    if (entry.event === "registered") bucket.registered += 1;
    else if (entry.event === "deregistered") bucket.deregistered += 1;
    else continue;
    byDay.set(day, bucket);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, bucket]) => ({
      key: day,
      label: day,
      axisLabel: day.slice(5),
      total: bucket.registered + bucket.deregistered,
      segments: [
        { key: "registered", label: "Registered", value: bucket.registered },
        { key: "deregistered", label: "Deregistered", value: bucket.deregistered },
      ],
    }))
    .filter((column) => column.total > 0);
}

/** The oldest and newest day the lifecycle capture covers. */
export function churnWindow(entries: readonly SubnetLifecycleEntry[]): [string, string] | null {
  const days = entries
    .map((entry) => entry.observed_at?.slice(0, 10))
    .filter((day): day is string => Boolean(day))
    .sort();
  const first = days[0];
  const last = days[days.length - 1];
  return first && last ? [first, last] : null;
}

export interface DirectoryRow extends Subnet {
  api_spec?: "yes" | "no" | "unknown";
  emission_share?: number;
  alpha_price_tao?: number;
  alpha_price_change_7d?: number;
  subnet_volume_tao?: number;
  domain?: string;
}

/**
 * The registry list joined with economics and the domain taxonomy.
 *
 * A left join on the registry: a subnet the economics snapshot has not priced
 * yet still gets a row, because the directory's job is to list every subnet
 * and a missing price is a fact about the price, not about the subnet.
 */
export function directoryRows(
  subnets: readonly Subnet[],
  economics: readonly SubnetEconomics[],
  domainOf: (netuid: number) => string | undefined,
): DirectoryRow[] {
  const byNetuid = new Map<number, SubnetEconomics>();
  for (const row of economics) byNetuid.set(row.netuid, row);
  return subnets.map((subnet) => {
    const econ = byNetuid.get(subnet.netuid);
    return {
      ...subnet,
      emission_share: econ?.emission_share,
      alpha_price_tao: econ?.alpha_price_tao,
      // Normalised at the join, so the column and the ranking cannot disagree
      // about whether this field is a percentage or a fraction.
      alpha_price_change_7d: pctToFraction(econ?.alpha_price_change_7d),
      subnet_volume_tao: econ?.subnet_volume_tao,
      domain: domainOf(subnet.netuid),
    };
  });
}

/** Narrows the directory to the URL's filters. Every filter is AND. */
export function filterDirectory(
  rows: readonly DirectoryRow[],
  filters: {
    domain?: string;
    health?: string;
    api?: boolean;
    q?: string;
    /** The netuids `specSubnets` resolved; required for the `api` filter to bite. */
    withApi?: ReadonlySet<number>;
  },
): DirectoryRow[] {
  const query = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    if (filters.domain && row.domain !== filters.domain) return false;
    if (filters.health && row.health !== filters.health) return false;
    if (filters.api && !filters.withApi?.has(row.netuid)) return false;
    if (query) {
      const haystack = `${row.name ?? ""} ${row.netuid} ${row.slug ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/**
 * The service kind that separates a documented API from a merely reachable
 * one, inherited from the retired `/subnets/with-api` (#11316).
 */
export const SPEC_KIND = "openapi";

/**
 * The netuids publishing a machine-readable API contract.
 *
 * From `/api/v1/agent-catalog`, not the registry list: the list row carries a
 * surface COUNT and no interface kinds at all, so reading it returned false
 * for all 129 subnets. A subnet with six dashboards has six surfaces and
 * nothing to call.
 */
export function specSubnets(
  catalog: Record<number, { service_kinds?: string[] | null; service_count?: number }>,
): Set<number> {
  const out = new Set<number>();
  for (const [netuid, entry] of Object.entries(catalog)) {
    if (apiSpecStatus(entry) === "yes") out.add(Number(netuid));
  }
  return out;
}

/** Missing kinds, including blocked catalog entries, do not establish absence. */
export function apiSpecStatus(entry?: {
  service_kinds?: string[] | null;
  service_count?: number;
}): "yes" | "no" | "unknown" {
  if (entry?.service_kinds != null) {
    return entry.service_kinds.includes(SPEC_KIND) ? "yes" : "no";
  }
  return entry?.service_count === 0 ? "no" : "unknown";
}
