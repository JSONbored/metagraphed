import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { MethodologyCallout } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { validatorHistoryQuery } from "@/lib/metagraphed/queries";
import {
  apyFromRewardsPer1000,
  formatApyPct,
  type ValidatorApyWindow,
} from "@/lib/metagraphed/validator-apy";

const WINDOWS: ValidatorApyWindow[] = ["7d", "30d", "90d"];

function latestRewards(points: Array<{ rewards_per_1000_tao?: number | null }>) {
  for (const p of points) {
    const v = p.rewards_per_1000_tao;
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Multi-window delegator APY tiles from validator history (#5245 / #2551 methodology). */
export function ValidatorApyPanel({
  hotkey,
  take,
  generatedAt,
}: {
  hotkey: string;
  take: number | null;
  generatedAt?: string | null;
}) {
  const results = useQueries({
    queries: WINDOWS.map((window) => ({
      ...validatorHistoryQuery(hotkey, window),
      staleTime: 60_000,
    })),
  });

  const rows = useMemo(
    () =>
      WINDOWS.map((window, i) => {
        const points = results[i]?.data?.data?.points ?? [];
        const rewards = latestRewards(points);
        return {
          window,
          apy: apyFromRewardsPer1000(rewards, take),
        };
      }),
    [results, take],
  );

  const anyLoading = results.some((r) => r.isLoading);
  const anyValue = rows.some((r) => r.apy != null);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map((row) => (
          <Panel as="div" flush key={row.window}>
            <div className="px-4 py-3">
              <div className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                Est. APY · {row.window}
              </div>
              <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink-strong">
                {anyLoading && row.apy == null ? "…" : formatApyPct(row.apy)}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">
                Net of take · daily neuron_daily rollup
              </p>
            </div>
          </Panel>
        ))}
      </div>
      {!anyLoading && !anyValue ? (
        <p className="text-[11px] text-ink-muted">
          APY estimates need stake and emission history — they appear once enough daily snapshots
          exist for this validator.
        </p>
      ) : null}
      <MethodologyCallout
        generatedAt={generatedAt ?? undefined}
        windowLabel="history windows"
        stakeRisk
      />
      <p className="text-[11px] leading-relaxed text-ink-muted">
        Delegator APY annualizes the latest daily rewards-per-1k-τ rate from neuron_daily, net of
        validator take. Snapshot-tier emission can lag; server-side modelling (#2551) will replace
        this client estimate.
      </p>
    </div>
  );
}
