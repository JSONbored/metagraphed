import { formatNumber } from "@/lib/metagraphed/format";
import type { Provider } from "@/lib/metagraphed/types";
import type { ProviderCounts } from "@/lib/metagraphed/queries";

/**
 * Display strings a provider card derives from a `Provider` row and its
 * endpoint `ProviderCounts`. Kept pure (no JSX, no component imports) so the
 * null/fallback branches are unit-tested apart from the DOM — the mobile
 * fallback cards on the Providers table render from this.
 */
export interface ProviderCardFields {
  /** Display name, falling back to the slug when the provider has no name. */
  name: string;
  /** Provider kind, falling back to a generic "provider" label. */
  kindLabel: string;
  subnetsLabel: string;
  surfacesLabel: string;
  endpointsLabel: string;
}

/** Resolve the labelled fields a provider card renders (counts default to 0). */
export function resolveProviderCard(p: Provider, counts?: ProviderCounts): ProviderCardFields {
  return {
    name: p.name ?? p.slug,
    kindLabel: p.kind ?? "provider",
    subnetsLabel: formatNumber(counts?.subnets ?? 0),
    surfacesLabel: formatNumber(counts?.surfaces ?? 0),
    endpointsLabel: formatNumber(counts?.endpoints ?? 0),
  };
}
