/**
 * Pure view-models for /about (#11627).
 *
 * The page is prose plus four numbers; these are the four numbers. They come
 * from three independent queries, so each can be pending, failed, or
 * legitimately absent, and the page has to tell those apart rather than
 * collapsing all three to a dash — `aboutFacts` returns `null` for "no value"
 * and the caller decides what a `null` means from its own query state.
 */

export interface AboutFact {
  label: string;
  value: string;
  /** Where the number is explained in full. */
  href: string;
}

/** A level in one of the two taxonomies the registry publishes. */
export interface TaxonomyLevel {
  name: string;
  meaning: string;
}

/**
 * Curation level: how a subnet's overlay came to exist. Mirrors the
 * `curation_level` vocabulary the coverage artifact reports — the same five
 * values `coverage.curation_level_counts` is keyed by.
 */
export const CURATION_LEVELS: readonly TaxonomyLevel[] = [
  { name: "native", meaning: "Sourced directly from the Bittensor chain." },
  { name: "candidate-discovered", meaning: "Leads from public sources, not yet verified." },
  { name: "machine-verified", meaning: "Reachable and shape-checked by automated probes." },
  { name: "maintainer-reviewed", meaning: "A human reviewer accepted the overlay." },
  { name: "adapter-backed", meaning: "A typed adapter publishes live metrics." },
];

/** Coverage level: how far a subnet has got through that ladder. */
export const COVERAGE_LEVELS: readonly TaxonomyLevel[] = [
  { name: "native-only", meaning: "Chain identity present, no curated overlay yet." },
  { name: "manifested", meaning: "Curated overlay with at least one public surface." },
  { name: "probed", meaning: "Surfaces or endpoints actively probed for health and freshness." },
];

/** What the project is not — the four claims worth stating outright. */
export const SCOPE_EXCLUSIONS: readonly string[] = [
  "Not an OpenTensor or Bittensor Foundation product — an independent, unofficial project.",
  "Not a custodial wallet or exchange — your keys and funds never leave your own wallet, and any signing stays local.",
  "No private keys, PATs, or token-gated data are ever requested or displayed.",
  "Endpoint pool eligibility is metadata only — proxy routing is future-scoped.",
];

interface AboutSources {
  coverage: Record<string, unknown> | null | undefined;
  health: Record<string, unknown> | null | undefined;
  freshness: Record<string, unknown> | null | undefined;
}

function num(source: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The four hero numbers, each rendered as a string or `null`.
 *
 * `adapter-backed` reads `curation_level_counts["adapter-backed"]`, never
 * `coverage.adapter_backed` — that key does not exist, and the fallback it
 * used to take (`first_party_subnet_count`) is a different metric entirely
 * (73 rather than 2), so the page reported first-party subnets under an
 * adapter-backed label for as long as that fallback stood.
 */
export function aboutFacts(
  sources: AboutSources,
): { label: string; value: string | null; href: string }[] {
  const counts = (sources.coverage?.["curation_level_counts"] ?? {}) as Record<string, unknown>;
  const adapterBacked = counts["adapter-backed"];
  const ok = num(sources.health, "ok");
  const total = num(sources.health, "total");
  const age = num(sources.freshness, "avg_age_seconds");
  const active = num(sources.coverage, "netuids_active");
  return [
    { label: "Active subnets", value: active == null ? null : String(active), href: "/subnets" },
    {
      label: "Adapter-backed",
      value:
        typeof adapterBacked === "number" && Number.isFinite(adapterBacked)
          ? String(adapterBacked)
          : null,
      href: "/apis/providers",
    },
    {
      label: "Healthy surfaces",
      value: ok != null && total != null && total > 0 ? `${ok}/${total}` : null,
      href: "/health",
    },
    {
      label: "Avg freshness",
      value: age == null ? null : formatAge(age),
      href: "/health",
    },
  ];
}

/** Seconds -> the shortest honest unit, so a hero cell never wraps. */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
