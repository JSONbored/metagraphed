import { Suspense } from "react";
import { EconomicsMini } from "@/components/metagraphed/charts/economics-mini";
import { ActivityHeatmap } from "@/components/metagraphed/charts/activity-heatmap";
import { Skeleton } from "@/components/metagraphed/states";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";

/**
 * Hero-adjacent two-up: an economics mini-chart (price + pool composition)
 * and a registry activity heatmap. Stacks on mobile, side-by-side on lg+.
 */
export function SubnetPulseStrip({ netuid }: { netuid: number }) {
  return (
    <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <QueryErrorBoundary fallback={() => null}>
        <Suspense fallback={<Skeleton className="h-44 w-full" />}>
          <EconomicsMini netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
      <QueryErrorBoundary fallback={() => null}>
        <Suspense fallback={<Skeleton className="h-44 w-full" />}>
          <ActivityHeatmap netuid={netuid} />
        </Suspense>
      </QueryErrorBoundary>
    </div>
  );
}
