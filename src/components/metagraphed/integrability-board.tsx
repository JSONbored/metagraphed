import { useSuspenseQuery } from "@tanstack/react-query";
import { Gauge, Layers, CheckCircle2 } from "lucide-react";
import { StatTile } from "@/components/metagraphed/charts/stat-tile";
import { BarMini, type BarMiniDatum } from "@/components/metagraphed/charts/bar-mini";
import { coverageQuery } from "@/lib/metagraphed/queries";
import type { Coverage } from "@/lib/metagraphed/types";

// Fixed bucket order for the score distribution (the API keys are unordered).
const SCORE_BUCKETS = ["0-24", "25-49", "50-74", "75-99", "100"];

function dimensionColor(pct: number): string {
  if (pct >= 75) return "var(--health-ok)";
  if (pct >= 40) return "var(--accent)";
  return "var(--health-warn)";
}

/**
 * Turns the registry's own `coverage.completeness` into a public scoreboard:
 * which integration dimensions are well-covered vs the biggest gaps (sorted
 * lowest-coverage first, since those are the most actionable for contributors),
 * plus the overall completeness-score distribution. Read-only; derived data.
 */
export function IntegrabilityBoard() {
  const coverage = (useSuspenseQuery(coverageQuery()).data.data ?? {}) as Coverage;
  const completeness = coverage.completeness;
  const dims = completeness?.dimension_coverage ?? {};

  const dimensionData: BarMiniDatum[] = Object.entries(dims)
    .map(([label, d]) => ({
      label,
      value: Math.round(d?.pct ?? 0),
      color: dimensionColor(d?.pct ?? 0),
    }))
    .sort((a, b) => a.value - b.value);

  const distribution: BarMiniDatum[] = SCORE_BUCKETS.filter(
    (b) => completeness?.score_distribution?.[b] != null,
  ).map((b) => ({ label: b, value: completeness?.score_distribution?.[b] ?? 0 }));

  const avg = completeness?.average_score;
  const median = completeness?.median_score;
  const fullyPct = completeness?.fully_complete_pct;
  const fullyCount = completeness?.fully_complete_count;

  if (dimensionData.length === 0 && distribution.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatTile
          icon={Gauge}
          eyebrow="Average score"
          value={avg != null ? `${Math.round(avg)}` : "—"}
          hint="/ 100"
        />
        <StatTile
          icon={Layers}
          eyebrow="Median score"
          value={median != null ? `${Math.round(median)}` : "—"}
          hint="/ 100"
        />
        <StatTile
          icon={CheckCircle2}
          eyebrow="Fully complete"
          value={fullyPct != null ? `${Math.round(fullyPct)}%` : "—"}
          hint={fullyCount != null ? `${fullyCount} subnets` : undefined}
          tone="ok"
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {dimensionData.length > 0 ? (
          <div className="rounded border border-border bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="font-display text-sm font-semibold text-ink-strong">
                Coverage by dimension
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                % of subnets
              </span>
            </div>
            <BarMini data={dimensionData} max={100} />
            <p className="mt-2 text-[11px] text-ink-muted">
              Lowest-coverage dimensions first — the biggest gaps to fill.
            </p>
          </div>
        ) : null}

        {distribution.length > 0 ? (
          <div className="rounded border border-border bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="font-display text-sm font-semibold text-ink-strong">
                Completeness scores
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
                subnets
              </span>
            </div>
            <BarMini data={distribution} />
            <p className="mt-2 text-[11px] text-ink-muted">
              How subnet completeness scores are distributed across the registry.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
