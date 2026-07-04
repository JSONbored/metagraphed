import { Compass } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { coverageQuery } from "@/lib/metagraphed/queries";
import { getNetwork } from "@/lib/metagraphed/config";

/**
 * Shown when a route's data 404s with `artifact_not_found` on a non-mainnet
 * network. Those partitions (e.g. testnet) carry native chain data only, so
 * most enrichment / health / interface artifacts legitimately don't exist yet
 * — an informational empty notice (surfacing the API's own `coverage.notes`)
 * is the honest signal, not a red error card (#370).
 */
export function NativeOnlyNotice({ context }: { context?: string }) {
  const network = getNetwork();
  // Coverage is one of the few artifacts every network publishes, so this
  // never itself 404s. Plain (non-suspense) query: it must not throw inside an
  // error fallback.
  const { data: coverage } = useQuery(coverageQuery());
  const notes = typeof coverage?.data?.notes === "string" ? coverage.data.notes.trim() : "";

  return (
    <div role="status" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Compass className="size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-display text-sm font-medium text-ink-strong">
            {network.label} carries native chain data only
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">
            {notes ||
              `${
                context ? `The ${context} view` : "This view"
              } isn't published for ${network.label}. Switch to Mainnet for curated interfaces, health, and enrichment data.`}
          </p>
        </div>
      </div>
    </div>
  );
}
