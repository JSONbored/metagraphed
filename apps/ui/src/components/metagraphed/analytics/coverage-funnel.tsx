import { useSuspenseQuery } from "@tanstack/react-query";
import { coverageQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import type { Coverage } from "@/lib/metagraphed/types";

interface Step {
  key: string;
  label: string;
  value: number;
  hint: string;
  tone: "default" | "accent" | "warn";
}

/**
 * Curation funnel: Active subnets → Manifested → Endpoints probed → Adapter-backed.
 * Renders bars sized relative to the largest step, with a conversion %
 * relative to the previous step. Coverage shape is forgiving — missing
 * fields just collapse the corresponding step.
 */
export function CoverageFunnel({ className }: { className?: string }) {
  const { data: res } = useSuspenseQuery(coverageQuery());
  const c = (res.data ?? {}) as Coverage;

  // Wired to the live /api/v1/coverage shape (#1124): chain_subnet_count,
  // manifested_count/curated_overlay_count, probed_surface_count, and the
  // adapter-backed tier from curation_level_counts.
  const cc = (c.curation_level_counts as Record<string, number> | undefined) ?? {};
  const active =
    (c.netuids_active as number | undefined) ?? (c.chain_subnet_count as number | undefined) ?? 0;
  const manifested =
    (c.manifested_count as number | undefined) ??
    (c.curated_overlay_count as number | undefined) ??
    0;
  const probed =
    (c.probed_surface_count as number | undefined) ??
    (c.probed_count as number | undefined) ??
    (c.surface_count as number | undefined) ??
    0;
  const adapter = cc["adapter-backed"] ?? (c.adapter_backed as number | undefined) ?? 0;

  const steps: Step[] = [
    {
      key: "active",
      label: "Active subnets",
      value: active,
      hint: "native chain",
      tone: "default",
    },
    {
      key: "manifested",
      label: "Manifested",
      value: manifested,
      hint: "with curated overlay",
      tone: "default",
    },
    { key: "probed", label: "Probed", value: probed, hint: "endpoints monitored", tone: "default" },
    {
      key: "adapter",
      label: "Adapter-backed",
      value: adapter,
      hint: "live machine-verified",
      tone: "accent",
    },
  ];

  const max = Math.max(1, ...steps.map((s) => s.value));

  return (
    <Panel as="div" flush className={className}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="mg-type-micro text-ink-muted">Curation funnel</div>
            <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
              Registry depth
            </h3>
          </div>
          <InfoTooltip label="Each step's bar is scaled to the largest step; the % shows conversion from the previous step." />
        </div>
        <ol className="space-y-3">
          {steps.map((s, i) => {
            const prev = i === 0 ? null : steps[i - 1]!.value;
            const conv = prev && prev > 0 ? (s.value / prev) * 100 : null;
            const width = (s.value / max) * 100;
            return (
              <li key={s.key} className="space-y-1">
                <div className="flex items-baseline justify-between text-xs">
                  <div className="flex items-baseline gap-2 min-w-0">
                    <span className="mg-type-micro text-ink-muted shrink-0">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="font-display font-medium text-ink-strong truncate">
                      {s.label}
                    </span>
                    <span className="font-mono text-[10px] text-ink-muted truncate">{s.hint}</span>
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0 tabular-nums">
                    {conv != null ? (
                      <span
                        className={classNames(
                          "font-mono text-[10px]",
                          conv >= 90
                            ? "text-health-ok"
                            : conv >= 50
                              ? "text-ink-muted"
                              : "text-health-warn",
                        )}
                        title={`${conv.toFixed(1)}% of previous step`}
                      >
                        {conv.toFixed(0)}%
                      </span>
                    ) : null}
                    <span className="font-display text-sm font-semibold text-ink-strong">
                      {formatNumber(s.value)}
                    </span>
                  </div>
                </div>
                <div className="h-1.5 rounded-full bg-border/40 overflow-hidden" aria-hidden>
                  <div
                    className={classNames(
                      "h-full rounded-full transition-all duration-500",
                      s.tone === "accent" && "bg-accent",
                      s.tone === "warn" && "bg-health-warn",
                      s.tone === "default" && "bg-ink-muted/60",
                    )}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </Panel>
  );
}
