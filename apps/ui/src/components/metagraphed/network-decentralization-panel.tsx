import { FactCell } from "@jsonbored/ui-kit";
import { useSuspenseQuery } from "@tanstack/react-query";
import { chainConcentrationQuery, chainPerformanceQuery } from "@/lib/metagraphed/queries";
import { EmptyState, Skeleton } from "@/components/metagraphed/states";
import {
  networkDecentralizationModel,
  type DecentralizationTile,
} from "@/lib/metagraphed/network-decentralization";

// #3471: network-scope decentralization scorecard — the chain-wide twin of the
// per-subnet concentration panel. Feeds from the already-shipped-but-unwired
// chainConcentrationQuery + chainPerformanceQuery (#3609). The data layer is
// untouched; this only consumes the normalized shape via useQuery and maps it
// through the pure networkDecentralizationModel helper.

// Per-metric explainers (#5330): what each score means and which direction is
// healthier, surfaced as an info tooltip on each tile.

// Suspense fallback that mirrors the panel's own grid (6 concentration tiles +
// a 3-tile score row) so the skeleton occupies the same responsive height as
// the loaded content — no layout shift when the data arrives, unlike a single
// flat box.
export function NetworkDecentralizationSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px]" />
        ))}
      </div>
      <div>
        <Skeleton className="mb-3 h-3 w-48" />
        <div className="grid gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px]" />
          ))}
        </div>
      </div>
    </div>
  );
}

function Tile({ tile }: { tile: DecentralizationTile }) {
  return <FactCell label={tile.label} value={tile.value} hint={tile.hint} />;
}

/**
 * Chain-wide decentralization scorecard: stake/emission concentration (Gini,
 * HHI, Nakamoto coefficient, entropy, top-1% share) plus the 0-1 trust /
 * consensus / validator-trust score spread — the same KPI-tile grid as the
 * per-subnet concentration panel, at network scope. Fetches both snapshots
 * once (shared cache) and renders through the pure view-model helper.
 */
export function NetworkDecentralizationPanel() {
  // Suspense-driven loading (the Suspense fallback in status.tsx renders the
  // Skeleton) and QueryErrorBoundary-driven errors, matching every sibling
  // section on the status page — so a fetch error surfaces as a distinct error
  // state rather than being conflated with a legitimately-empty result below.
  const { data: cRes } = useSuspenseQuery(chainConcentrationQuery());
  const { data: pRes } = useSuspenseQuery(chainPerformanceQuery());

  const model = networkDecentralizationModel(cRes?.data, pRes?.data);

  if (!model.hasData) {
    return (
      <EmptyState
        title="No network decentralization metrics"
        description="Chain-wide stake- and emission-distribution metrics (Gini, HHI, Nakamoto coefficient, entropy, top-1% share) plus the 0-1 trust/consensus score spread are computed from the metagraph snapshot and will appear here once captured."
        lastChecked={cRes?.meta?.generated_at ?? pRes?.meta?.generated_at}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Stake & emission concentration — the headline distribution scorecard. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {model.concentrationTiles.map((tile) => (
          <Tile key={tile.key} tile={tile} />
        ))}
      </div>

      {/* 0-1 trust / consensus / validator-trust score spread. */}
      <div>
        <div className="mb-3 text-13 text-ink-muted">Trust &amp; consensus score spread</div>
        <div className="grid gap-3 sm:grid-cols-3">
          {model.scoreTiles.map((tile) => (
            <Tile key={tile.key} tile={tile} />
          ))}
        </div>
      </div>
    </div>
  );
}
