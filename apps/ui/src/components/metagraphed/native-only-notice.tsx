import { Compass } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { coverageQuery } from "@/lib/metagraphed/queries";
import { getNetwork } from "@/lib/metagraphed/config";

/**
 * Shown when a route's data 404s on a non-mainnet network, either because the
 * artifact simply isn't built yet (`artifact_not_found`) or because the route
 * is deliberately mainnet-only (`not_found` with `meta.network` set — see
 * `ErrorState` in ./states.tsx). An informational empty notice (surfacing the
 * API's own `coverage.notes`) is the honest signal, not a red error card (#370).
 *
 * THE HEADING NAMES THIS VIEW, NOT THE NETWORK. It used to read "{network}
 * carries native chain data only", which was a claim about the whole partition
 * rather than about the route that 404'd -- and it stopped being true as
 * testnet gained live chain state, blocks, extrinsics, chain events and the
 * analytics over them, while this card kept telling people the partition had
 * none of it. Scoping the sentence to the view keeps it correct however much
 * the network goes on to serve.
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
            Not published for {network.label}
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
