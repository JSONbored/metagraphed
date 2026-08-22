import { LineWithWindow } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { toLinePoints } from "@/components/metagraphed/metric-history";
import type { EconomicsTrendsDay } from "@/lib/metagraphed/types";

const formatShare = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * The one genuinely windowed trend in this tab's "trend row" — a real daily
 * series from /api/v1/economics/trends, unlike the concentration/idle-stake
 * modules alongside it (both point-in-time snapshots; no chain-level history
 * endpoint exists for either).
 */
export function ChainEmissionTrend({
  days,
  window,
}: {
  days: EconomicsTrendsDay[];
  window: string;
}) {
  const points = toLinePoints(
    days,
    (d) => d.snapshot_date,
    (d) => d.mean_emission_share,
  );
  const first = points[0];
  const last = points[points.length - 1];

  return (
    <Panel
      title="Mean emission share"
      caption={`Average per-subnet emission share, ${window} — a widening spread means emission is concentrating into fewer subnets.`}
    >
      {first && last ? (
        <LineWithWindow
          compact
          points={points}
          window={{ from: first.t, to: last.t }}
          unit="mean emission share"
          formatValue={formatShare}
          ariaLabel="Mean emission share over time"
          source="chain-emission-trend"
        />
      ) : (
        <EmptyState title="Not enough data yet" />
      )}
    </Panel>
  );
}
