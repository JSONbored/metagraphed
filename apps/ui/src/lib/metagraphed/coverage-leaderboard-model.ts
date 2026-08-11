/**
 * #10478: the network-wide coverage leaderboard's ordering, extracted because
 * the ordering is where this table can do harm.
 *
 * SORTING `null` AS `0` WOULD RANK 127 SUBNETS AS THE WORST PERFORMERS ON THE
 * NETWORK. They are not the worst performers; they are the unmeasured ones, and
 * a table that ranks them is making a claim about each of them at once. So
 * unmeasured subnets never enter the ranking at all — they are partitioned into
 * their own group, which the page renders separately and labels as what it is.
 *
 * The measured group sorts normally. Within it, `0` is a real value and ranks
 * like one, because an observed zero IS a measurement.
 */

export const COVERAGE_SORT_FIELDS = [
  "subsidy_multiple",
  "coverage_ratio",
  "emission_usd",
  "revenue_usd",
  "netuid",
] as const;

export type CoverageSortField = (typeof COVERAGE_SORT_FIELDS)[number];

export interface CoverageRow {
  netuid: number;
  name: string | null;
  provenance: string | null;
  coverage_ratio: number | null;
  subsidy_multiple: number | null;
  revenue_usd: number | null;
  emission_usd: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** One row of the served coverage artifact, defensively. */
export function toCoverageRow(raw: unknown): CoverageRow | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const netuid = finite(row.netuid);
  if (netuid == null) return null;
  const revenue = (row.revenue ?? row) as Record<string, unknown>;
  const emission = (revenue.emission ?? {}) as Record<string, unknown>;
  return {
    netuid,
    name: text(row.name) ?? text(row.subnet_name),
    provenance: text(revenue.provenance),
    coverage_ratio: finite(revenue.coverage_ratio),
    subsidy_multiple: finite(revenue.subsidy_multiple),
    revenue_usd: finite(revenue.revenue_usd),
    emission_usd: finite(emission.usd) ?? finite(row.emission_usd),
  };
}

export function toCoverageRows(raw: unknown): CoverageRow[] {
  if (!Array.isArray(raw)) return [];
  const out: CoverageRow[] = [];
  for (const item of raw) {
    const row = toCoverageRow(item);
    if (row) out.push(row);
  }
  return out;
}

/**
 * A subnet is MEASURED when it has an observed revenue figure.
 *
 * Keyed on `revenue_usd` rather than on the ratio, because the ratio can also
 * be null for a measured subnet whose emission side failed to price — and that
 * subnet has still been measured. It just cannot be ranked on that column.
 */
export function isMeasured(row: CoverageRow): boolean {
  return row.revenue_usd != null;
}

export interface PartitionedCoverage {
  /** Ranked. Every row here has an observed revenue figure. */
  measured: CoverageRow[];
  /** NOT ranked, and never interleaved with the above. */
  notObserved: CoverageRow[];
}

function compare(
  a: CoverageRow,
  b: CoverageRow,
  field: CoverageSortField,
  direction: "asc" | "desc",
): number {
  const av = a[field];
  const bv = b[field];
  // Within the measured group a null is still possible — an unpriced emission
  // side, say. It sorts LAST in either direction rather than as a zero, so a
  // column it cannot answer never promotes it to the top of that column.
  if (av == null && bv == null) return a.netuid - b.netuid;
  if (av == null) return 1;
  if (bv == null) return -1;
  const delta = direction === "asc" ? av - bv : bv - av;
  return delta || a.netuid - b.netuid;
}

/**
 * Split, then sort. The unmeasured group is never ordered by a metric it has no
 * value for — it is ordered by netuid, which is a fact about it.
 */
export function partitionAndSort(
  rows: CoverageRow[],
  field: CoverageSortField,
  direction: "asc" | "desc",
  { provenance }: { provenance?: string | null } = {},
): PartitionedCoverage {
  const filtered =
    provenance == null || provenance === ""
      ? rows
      : rows.filter((r) => r.provenance === provenance);
  const measured = filtered.filter(isMeasured);
  const notObserved = filtered.filter((r) => !isMeasured(r));
  return {
    measured: [...measured].sort((a, b) => compare(a, b, field, direction)),
    notObserved: [...notObserved].sort((a, b) => a.netuid - b.netuid),
  };
}

/** The tiers that can reach a headline ratio, for the filter's own labelling. */
export const HEADLINE_TIERS = new Set(["chain-verified", "probe-derived"]);

export interface ProvenanceOption {
  value: string;
  count: number;
  headlineEligible: boolean;
}

/**
 * The provenance filter's options, with counts.
 *
 * The counts are the point: the filter is how a reader learns the verified set
 * is two subnets wide, which a table showing only its own rows would hide.
 */
export function provenanceOptions(rows: CoverageRow[]): ProvenanceOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.provenance ?? "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      count,
      headlineEligible: HEADLINE_TIERS.has(value),
    }))
    .sort(
      (a, b) =>
        Number(b.headlineEligible) - Number(a.headlineEligible) ||
        b.count - a.count ||
        a.value.localeCompare(b.value),
    );
}

/** The line above the unmeasured group. Never "0% covered". */
export function notObservedNote(count: number, total: number): string {
  return (
    `${count} of ${total} subnets have no observable external revenue. ` +
    "They are listed separately rather than ranked, because ordering them by a " +
    "figure nobody measured would rank them as the network's worst performers — " +
    "which is a claim about each of them, and not one the data supports."
  );
}
