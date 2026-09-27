import { useHydrated } from "./use-hydrated";
import { formatRelative } from "@/lib/metagraphed/format";
import { formatFreshness } from "@/lib/metagraphed/freshness";

const initialRelative = (iso?: string | null) => formatRelative(iso, null);
const initialFreshness = (iso?: string | null, window?: string | null) =>
  formatFreshness(iso, window, null);

// SSR and the first browser render share an absolute UTC stamp. Once hydrated,
// retain the relative labels without a second fetch, clock timer, or warning suppression.
export function useRelativeTime() {
  return useHydrated() ? formatRelative : initialRelative;
}

export function useFreshnessTime() {
  return useHydrated() ? formatFreshness : initialFreshness;
}
