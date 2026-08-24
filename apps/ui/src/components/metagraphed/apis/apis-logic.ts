import type { SectionNavItem } from "@jsonbored/ui-kit";
import type { SchemaInfo, Surface } from "@/lib/metagraphed/types";

/**
 * The derivations behind the four /apis routes (#11622). Pure, so the pages
 * stay thin and every rule below is testable without a browser.
 */

/**
 * The hub's four routes as a `SectionNav`, which already takes `href` +
 * `current` for exactly this. It replaces the `HubTabs` strip: the entries are
 * the same, and one nav primitive across the site is the point of #11607.
 */
export function apisNav(pathname: string): SectionNavItem[] {
  // No `|| "/apis"` fallback: "/apis" already survives the trailing-slash
  // strip, and the fallback only ever fired for "/" -- lighting Catalog on the
  // home page, where this nav does not render but where a shared helper must
  // still answer honestly.
  const path = pathname.replace(/\/+$/, "");
  return [
    { id: "apis", name: "Catalog", href: "/apis" },
    { id: "endpoints", name: "Endpoints", href: "/apis/endpoints" },
    { id: "schemas", name: "Schemas", href: "/apis/schemas" },
    { id: "providers", name: "Providers", href: "/apis/providers" },
  ].map((item) => ({ ...item, current: item.href === path }));
}

export interface Segment {
  key: string;
  label: string;
  value: number;
}

/** Surfaces by kind, largest first — what the network actually publishes. */
export function kindSegments(surfaces: readonly Surface[]): Segment[] {
  const counts = new Map<string, number>();
  for (const surface of surfaces) {
    const kind = surface.kind?.trim();
    if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, label: key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

/** The distinct values of one surface field, sorted, for a filter select. */
export function facet(
  surfaces: readonly Surface[],
  of: (surface: Surface) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const surface of surfaces) {
    const value = of(surface)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The catalog hero.
 *
 * "Probed" rather than "up": /api/v1/coverage publishes how many surfaces the
 * prober reaches, not how many answered, and the two are different claims. The
 * page that says "509/616 up" without a source for "up" is inventing the
 * numerator.
 */
export interface CoverageCounts {
  surface_count?: number;
  official_surface_count?: number;
  probed_surface_count?: number;
  chain_subnet_count?: number;
}

export function catalogFacts(
  coverage: CoverageCounts | null | undefined,
  kinds: number,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (!coverage) return [];
  const facts: Fact[] = [];
  if (typeof coverage.surface_count === "number") {
    facts.push({ key: "surfaces", label: "surfaces", value: fmt.count(coverage.surface_count) });
  }
  if (typeof coverage.chain_subnet_count === "number") {
    facts.push({
      key: "subnets",
      label: "across subnets",
      value: fmt.count(coverage.chain_subnet_count),
    });
  }
  if (kinds > 0) facts.push({ key: "kinds", label: "kinds", value: fmt.count(kinds) });
  if (typeof coverage.probed_surface_count === "number") {
    facts.push({ key: "probed", label: "probed", value: fmt.count(coverage.probed_surface_count) });
  }
  if (typeof coverage.official_surface_count === "number") {
    facts.push({
      key: "official",
      label: "first-party",
      value: fmt.count(coverage.official_surface_count),
    });
  }
  return facts;
}

export interface SchemaRow {
  key: string;
  netuid: number | null;
  subnet: string;
  title: string;
  status: string;
  drift: string;
  paths: number | null;
  components: number | null;
  observedAt: string | null;
  from: string | null;
  to: string | null;
  url: string | null;
}

/**
 * One row per captured or attempted schema, flattened out of the snapshot.
 *
 * Takes `SchemaInfo`, which is what `schemasQuery` returns — its index
 * signature carries the `snapshot` blob the normalizer spreads through
 * untouched. Typing this as `Record<string, unknown>[]` forced the caller
 * through `as unknown as`, which erases every relationship the compiler could
 * have checked; the fix belongs in the signature, not at the call site.
 */
export function schemaRows(schemas: readonly SchemaInfo[] | null | undefined): SchemaRow[] {
  if (!Array.isArray(schemas)) return [];
  return schemas.map((raw, i) => {
    // No cast: `SchemaInfo` carries an index signature, so the snapshot blob
    // the normalizer spreads through is reachable as `unknown` and narrowed
    // by the helpers below.
    const snapshot = (raw.snapshot ?? {}) as Record<string, unknown>;
    const netuid = typeof raw.netuid === "number" ? raw.netuid : null;
    return {
      key: String(raw.surface_id ?? `${netuid}-${i}`),
      netuid,
      subnet:
        str(raw.subnet_slug) ??
        str(snapshot.subnet_name) ??
        (netuid == null ? "—" : `sn-${netuid}`),
      title: str(snapshot.title) ?? str(raw.schema_url) ?? "—",
      status: str(raw.status) ?? "unknown",
      drift: str(raw.drift_status) ?? "unknown",
      paths: num(snapshot.path_count),
      components: num(snapshot.component_schema_count),
      observedAt: str(snapshot.observed_at),
      from: str(raw.previous_hash),
      to: str(raw.hash),
      url: str(raw.schema_url),
    };
  });
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface DriftRail {
  key: string;
  label: string;
  value: number;
  href: string;
  detail: { key: string; label: string; value: string }[];
}

/** The two drift states where a schema's CONTENT actually moved. */
export const MOVED = new Set(["changed", "new"]);

/**
 * The schemas whose content moved, ranked by how much surface moved with them.
 *
 * There is no published change weight, so this ranks on `path_count` — the
 * size of the spec that changed — and the column header says so rather than
 * dressing it up as a diff score.
 *
 * `not-captured` is deliberately NOT ranked here. It is a real drift state and
 * it must stay visible, but its magnitude is zero by definition, and seven
 * empty rails under two full ones is a ranking of nothing. The table below
 * defaults to every row that is not `unchanged`, so those seven sit one line
 * further down with their capture status stated — which is where "we could not
 * read it" belongs, next to the reason.
 */
export function driftRails(rows: readonly SchemaRow[], limit = 12): DriftRail[] {
  return rows
    .filter((row) => MOVED.has(row.drift))
    .sort((a, b) => (b.paths ?? 0) - (a.paths ?? 0) || a.subnet.localeCompare(b.subnet))
    .slice(0, limit)
    .map((row) => ({
      key: row.key,
      label: row.netuid == null ? row.subnet : `SN${row.netuid} ${row.subnet}`,
      value: row.paths ?? 0,
      href: row.netuid == null ? "/subnets" : `/subnets/${row.netuid}`,
      detail: [
        { key: "drift", label: "Drift", value: row.drift },
        { key: "status", label: "Capture", value: row.status },
        { key: "from", label: "Was", value: shortHash(row.from) },
        { key: "to", label: "Now", value: shortHash(row.to) },
      ],
    }));
}

/** A 64-hex digest as its first eight characters, or an em-dash. */
export function shortHash(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 8)}…` : "—";
}

export interface SchemaSummary {
  surface_count: number;
  by_status: Record<string, number>;
  by_drift_status: Record<string, number>;
  observed_at: string | null;
}

/**
 * The summary, counted off the rows this page is about to draw.
 *
 * /api/v1/schemas publishes its own `summary` block, but `schemasQuery`
 * returns the flat schema ARRAY -- its normalizer keeps the rows and drops the
 * envelope -- so reading `summary` off the query result yields undefined and
 * the hero renders empty. Counting the rows is also the honest version: the
 * facts then describe exactly the table underneath them, and cannot disagree
 * with it after a filter or a partial fetch.
 */
export function schemaSummary(rows: readonly SchemaRow[]): SchemaSummary {
  const by_status: Record<string, number> = {};
  const by_drift_status: Record<string, number> = {};
  let observed_at: string | null = null;
  for (const row of rows) {
    by_status[row.status] = (by_status[row.status] ?? 0) + 1;
    by_drift_status[row.drift] = (by_drift_status[row.drift] ?? 0) + 1;
    if (row.observedAt && (!observed_at || row.observedAt > observed_at)) {
      observed_at = row.observedAt;
    }
  }
  return { surface_count: rows.length, by_status, by_drift_status, observed_at };
}

/** The schemas hero. */
export function schemaFacts(
  summary:
    | {
        schema_count?: number;
        surface_count?: number;
        by_drift_status?: Record<string, number>;
        by_status?: Record<string, number>;
      }
    | null
    | undefined,
  subnetsCovered: number,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (!summary) return [];
  const drift = summary.by_drift_status ?? {};
  const facts: Fact[] = [];
  if (typeof summary.surface_count === "number") {
    facts.push({ key: "tracked", label: "tracked", value: fmt.count(summary.surface_count) });
  }
  if (typeof summary.by_status?.captured === "number") {
    facts.push({
      key: "captured",
      label: "captured",
      value: fmt.count(summary.by_status.captured),
    });
  }
  if (subnetsCovered > 0) {
    facts.push({ key: "subnets", label: "subnets", value: fmt.count(subnetsCovered) });
  }
  const moved = (drift.changed ?? 0) + (drift.new ?? 0);
  facts.push({ key: "moved", label: "moved since last capture", value: fmt.count(moved) });
  if (typeof drift["not-captured"] === "number") {
    facts.push({ key: "missing", label: "not captured", value: fmt.count(drift["not-captured"]) });
  }
  return facts;
}
