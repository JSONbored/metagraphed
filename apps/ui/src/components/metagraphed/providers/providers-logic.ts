import type { Endpoint, Provider, SourceHealthProvider, Surface } from "@/lib/metagraphed/types";

/**
 * The derivations behind /apis/providers and /providers/$slug (#11624). Pure,
 * so both pages stay thin and every rule below is testable without a browser.
 */

/** An authority a provider itself asserted, as opposed to one we observed. */
export const CLAIMED = new Set(["official", "provider-claimed"]);

export interface ProviderRow {
  slug: string;
  name: string;
  kind: string | null;
  authority: string | null;
  host: string | null;
  netuids: number[];
  surfaces: number | null;
  endpoints: number;
  /** From /api/v1/source-health: ok | degraded | unknown. */
  sourceStatus: string | null;
  updatedAt: string | null;
  iconUrl: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The directory rows, joined to source health by slug.
 *
 * /api/v1/providers publishes identity and counts; /api/v1/source-health
 * publishes whether the sources behind a provider still resolve. They are one
 * row to a reader asking "who runs this, and are they reliable", and joining
 * them here rather than in the page keeps the join testable — including the
 * case that matters, a provider with no health row, which must read `unknown`
 * rather than silently inheriting the previous row's status.
 */
export function providerRows(
  providers: readonly Provider[] | null | undefined,
  health: readonly SourceHealthProvider[] | null | undefined,
): ProviderRow[] {
  const byId = new Map<string, SourceHealthProvider>();
  for (const row of Array.isArray(health) ? health : []) {
    const id = str(row.id);
    if (id) byId.set(id, row);
  }
  return (Array.isArray(providers) ? providers : []).map((provider) => {
    const slug = str(provider.slug) ?? str(provider.id) ?? "";
    const hp = byId.get(slug);
    const netuids = Array.isArray(provider.netuids)
      ? (provider.netuids as unknown[]).filter((n): n is number => typeof n === "number")
      : [];
    return {
      slug,
      name: str(provider.name) ?? slug,
      kind: str(provider.kind),
      authority: str(provider.authority),
      host: str(provider.website) ?? str(provider.homepage) ?? str(provider.website_url),
      netuids,
      surfaces: num(provider.surfaces_count) ?? num(provider.surface_count),
      endpoints: num(provider.endpoints_count) ?? num(provider.endpoint_count) ?? 0,
      sourceStatus: hp ? (str(hp.status) ?? "unknown") : null,
      updatedAt: str(provider.generated_at) ?? str(provider.updated_at),
      iconUrl: typeof provider.icon_url === "string" ? provider.icon_url : str(provider.logo_url),
    };
  });
}

export interface Fact {
  key: string;
  label: string;
  value: string;
}

/**
 * The index hero.
 *
 * "Official or claimed" counts the two authorities a provider ASSERTED —
 * `official` and `provider-claimed` — against the two we merely observed. It
 * is the one number on this page that says how much of the directory is
 * first-party, which is the question behind "are they reliable".
 */
export function providerFacts(
  rows: readonly ProviderRow[],
  health: { status_counts?: Record<string, number>; endpoint_count?: number } | null | undefined,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (rows.length === 0) return [];
  const claimed = rows.filter((row) => row.authority && CLAIMED.has(row.authority)).length;
  const facts: Fact[] = [
    { key: "providers", label: "Providers", value: fmt.count(rows.length) },
    {
      key: "claimed",
      label: "Official or claimed",
      value: `${fmt.count(claimed)} (${Math.round((claimed / rows.length) * 100)}%)`,
    },
  ];
  const endpoints = health?.endpoint_count ?? rows.reduce((sum, row) => sum + row.endpoints, 0);
  facts.push({ key: "endpoints", label: "Endpoints", value: fmt.count(endpoints) });
  const counts = health?.status_counts;
  if (counts) {
    const ok = counts.ok ?? 0;
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (total > 0) {
      facts.push({
        key: "sources",
        label: "Sources resolving",
        value: `${fmt.count(ok)}/${fmt.count(total)}`,
      });
    }
  }
  return facts;
}

export interface Leader {
  key: string;
  name: string;
  sub?: string;
  value: string;
  href: string;
  initials: string;
}

/**
 * Providers by endpoints served.
 *
 * No `delta`: `LeaderCards` draws one as a period-over-period change, and
 * nothing published here is a period — /api/v1/providers is a snapshot with no
 * previous endpoint count to compare against. A delta computed from anything
 * else would be a number that looks like growth and is not.
 */
export function providerLeaders(rows: readonly ProviderRow[], limit = 18): Leader[] {
  return [...rows]
    .filter((row) => row.endpoints > 0)
    .sort((a, b) => b.endpoints - a.endpoints || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((row) => ({
      key: row.slug,
      name: row.name,
      sub: row.kind ?? undefined,
      value: String(row.endpoints),
      href: `/providers/${row.slug}`,
      initials: initials(row.name),
    }));
}

/** Up to two letters for an avatar fallback. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export interface DirectoryFilters {
  q: string;
  kind: string;
  authority: string;
}

/** The directory filter. Search covers name, slug and host. */
export function filterProviders(
  rows: readonly ProviderRow[],
  filters: DirectoryFilters,
): ProviderRow[] {
  const q = filters.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.kind && row.kind !== filters.kind) return false;
    if (filters.authority && row.authority !== filters.authority) return false;
    if (!q) return true;
    return [row.name, row.slug, row.host].some(
      (field) => typeof field === "string" && field.toLowerCase().includes(q),
    );
  });
}

/** The distinct values of one field, sorted, for a filter select. */
export function facet<Row>(
  rows: readonly Row[],
  of: (row: Row) => string | null | undefined,
): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = of(row)?.trim();
    if (value) seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export interface EndpointRail {
  key: string;
  label: string;
  value: number;
  detail: { key: string; label: string; value: string }[];
}

/**
 * One provider's endpoints ranked by last-probe latency.
 *
 * The issue asked for 90-day uptime and a p50 series over time. Neither is
 * published: /api/v1/providers/{slug}/endpoints carries one probe per endpoint
 * — `latency_ms`, `status`, `last_checked`, `last_ok` — and no history route
 * exists for either. This is the reading the data supports, and the section
 * footnote says which probe it is.
 */
export function endpointRails(
  endpoints: readonly Endpoint[] | null | undefined,
  limit = 20,
): EndpointRail[] {
  return (Array.isArray(endpoints) ? endpoints : [])
    .filter((endpoint) => num(endpoint.latency_ms) != null && num(endpoint.latency_ms)! > 0)
    .sort((a, b) => num(b.latency_ms)! - num(a.latency_ms)!)
    .slice(0, limit)
    .map((endpoint, i) => ({
      key: str(endpoint.id) ?? `endpoint-${i}`,
      label:
        [str(endpoint.kind), hostOf(str(endpoint.url))].filter(Boolean).join(" · ") || "endpoint",
      value: num(endpoint.latency_ms)!,
      detail: [
        { key: "status", label: "Status", value: str(endpoint.status) ?? "unknown" },
        { key: "probe", label: "Last ok", value: str(endpoint.last_ok) ?? "never" },
      ],
    }));
}

/** A surface with whatever the prober last found for it. */
export interface ProviderSurfaceRow extends Surface {
  probeStatus: string | null;
  probeLatencyMs: number | null;
  probedAt: string | null;
}

/**
 * One list, not two.
 *
 * A provider page rendered an Endpoints table and a Surfaces table, and for a
 * provider whose surfaces are ALL probed endpoints -- which is most of them --
 * that is the same rows twice, 156 and 156, under two identities and two
 * column sets (#11696). Surfaces is the superset: an endpoint is a surface the
 * prober watches, and a docs page is a surface it does not.
 *
 * Joined on the URL rather than the id: `/endpoints` numbers a row
 * `endpoint-srf-<hash>` and `/surfaces` numbers the same thing
 * `sn-51-<provider>-<path>`, so the ids never match, while the URL is the
 * thing both records are ABOUT. A surface with no matching endpoint keeps its
 * three probe fields null, which is the honest answer for something nobody
 * probes.
 */
export function mergeSurfaceProbes(
  surfaces: readonly Surface[],
  endpoints: readonly Endpoint[],
): ProviderSurfaceRow[] {
  const byUrl = new Map<string, Endpoint>();
  for (const endpoint of endpoints) {
    if (typeof endpoint.url === "string" && endpoint.url) byUrl.set(endpoint.url, endpoint);
  }
  return surfaces.map((surface) => {
    const probe = typeof surface.url === "string" ? byUrl.get(surface.url) : undefined;
    return {
      ...surface,
      probeStatus: typeof probe?.status === "string" ? probe.status : null,
      probeLatencyMs: typeof probe?.latency_ms === "number" ? probe.latency_ms : null,
      probedAt: typeof probe?.last_checked === "string" ? probe.last_checked : null,
    };
  });
}

/** The host of a URL, or the URL, or null — never a thrown TypeError. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || url;
  }
}

/**
 * The detail hero.
 *
 * The healthy share is over the endpoints with a STATED status, for the same
 * reason the fleet page computes it that way: an unmonitored endpoint is not
 * an unhealthy one, and counting it as such reports a provider's coverage as
 * its reliability.
 */
export function providerDetailFacts(
  provider: Provider | null | undefined,
  summary:
    | { endpoint_count?: number; monitored_count?: number; by_status?: Record<string, number> }
    | null
    | undefined,
  surfaces: number,
  fmt: { count: (n: number) => string },
): Fact[] {
  if (!provider) return [];
  const facts: Fact[] = [];
  if (provider.authority) {
    facts.push({ key: "authority", label: "Authority", value: String(provider.authority) });
  }
  if (surfaces > 0) facts.push({ key: "surfaces", label: "Surfaces", value: fmt.count(surfaces) });
  const count = num(summary?.endpoint_count);
  if (count != null) facts.push({ key: "endpoints", label: "Endpoints", value: fmt.count(count) });
  const status = summary?.by_status ?? {};
  const measured = Object.entries(status)
    .filter(([key]) => key !== "unknown")
    .reduce((sum, [, n]) => sum + n, 0);
  if (measured > 0) {
    facts.push({
      key: "healthy",
      label: "Healthy",
      value: `${Math.round(((status.ok ?? 0) / measured) * 100)}% of ${fmt.count(measured)}`,
    });
  }
  return facts;
}

/** The surfaces this provider publishes, newest verification first. */
export function providerSurfaces(surfaces: readonly Surface[] | null | undefined): Surface[] {
  return [...(Array.isArray(surfaces) ? surfaces : [])].sort(
    (a, b) => (a.netuid ?? 0) - (b.netuid ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
  );
}
