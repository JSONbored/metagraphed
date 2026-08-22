import { useSuspenseQuery } from "@tanstack/react-query";
import { RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { coverageQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";
import type { Coverage } from "@/lib/metagraphed/types";

interface Step {
  key: string;
  label: string;
  value: number;
  hint: string;
}

/**
 * Curation funnel: Active subnets → Manifested → Endpoints probed → Adapter-backed,
 * as ranked rails scaled to the first step, each row carrying its conversion
 * against the previous step. Coverage shape is forgiving — missing fields just
 * collapse the corresponding step.
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
    { key: "active", label: "Active subnets", value: active, hint: "native chain" },
    { key: "manifested", label: "Manifested", value: manifested, hint: "with curated overlay" },
    { key: "probed", label: "Probed", value: probed, hint: "endpoints monitored" },
    { key: "adapter", label: "Adapter-backed", value: adapter, hint: "live machine-verified" },
  ];

  const items: RankedRailItem[] = steps.map((s, i) => {
    const prev = i === 0 ? null : steps[i - 1]!.value;
    const conversion = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null;
    return {
      key: s.key,
      label: s.label,
      value: s.value,
      detail: [
        { key: "hint", label: "what counts", value: s.hint },
        ...(conversion === null
          ? []
          : [{ key: "conversion", label: "of previous step", value: `${conversion}%` }]),
      ],
    };
  });
  const first = steps[0]!.value;

  return (
    <Panel
      title="Curation funnel"
      caption="Active subnets → manifested → probed → adapter-backed."
      className={className}
    >
      <RankedRails
        items={items}
        formatValue={(v) => formatNumber(v)}
        max={first > 0 ? first : undefined}
        columns={{ value: "Subnets", name: "Step", track: "0–100%" }}
        limit={steps.length}
        ariaLabel="Curation funnel, active subnets down to adapter-backed"
        source="coverage-funnel"
      />
    </Panel>
  );
}
