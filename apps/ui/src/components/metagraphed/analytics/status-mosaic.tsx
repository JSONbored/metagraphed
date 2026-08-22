import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CompositionBreakdown, type CompositionSegment } from "@jsonbored/ui-kit";
import { endpointsQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { useTimeRange, RANGE_HOURS, RANGE_LABEL } from "./time-range-context";
import type { Endpoint } from "@/lib/metagraphed/types";

const STATES = ["ok", "warn", "down", "unknown"] as const;

/**
 * Probed endpoints by latest health state, as one composition bar. The
 * single-glance "is anything red right now?" view.
 */
export function StatusMosaic({ className, limit = 240 }: { className?: string; limit?: number }) {
  const { range } = useTimeRange();
  const cutoff = Date.now() - RANGE_HOURS[range] * 3_600_000;
  const { data: res } = useSuspenseQuery(endpointsQuery({ limit }));
  const allEndpoints = useMemo(() => (res.data ?? []) as Endpoint[], [res.data]);
  const endpoints = useMemo(
    () =>
      allEndpoints.filter((e) => {
        if (!e.last_probed_at) return true; // keep unprobed
        const t = Date.parse(e.last_probed_at);
        if (!Number.isFinite(t)) return true;
        return t >= cutoff;
      }),
    [allEndpoints, cutoff],
  );

  const segments = useMemo<CompositionSegment[]>(() => {
    const counts: Record<string, number> = { ok: 0, warn: 0, down: 0, unknown: 0 };
    for (const e of endpoints) {
      const state = e.health ?? "unknown";
      counts[state] = (counts[state] ?? 0) + 1;
    }
    return STATES.map((k) => ({ key: `health:${k}`, label: k, value: counts[k] ?? 0 }));
  }, [endpoints]);

  return (
    <Panel
      title={`Endpoint status · ${RANGE_LABEL[range]}`}
      caption={`${formatNumber(endpoints.length)} endpoint${endpoints.length === 1 ? "" : "s"} probed in range, by latest state.`}
      className={className}
    >
      {endpoints.length === 0 ? (
        <EmptyState title="No endpoints probed in this range" />
      ) : (
        <CompositionBreakdown
          segments={segments}
          formatValue={(v) => formatNumber(v)}
          ariaLabel="Endpoints by health state"
          source="status-mosaic"
        />
      )}
    </Panel>
  );
}
