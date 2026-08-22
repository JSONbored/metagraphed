import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CompositionBreakdown, type CompositionSlice } from "@jsonbored/ui-kit";
import { subnetSurfacesQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * Registry vocabulary, in the reader's words.
 *
 * The `kind` enum is contributor-facing — a visitor should not have to know
 * that "source-repo" and "data-artifact" are enum members to read a chart.
 * An unmapped kind falls through to a tidied version of its own slug rather
 * than being dropped, so a new kind appears rather than silently vanishing.
 */
const KIND_LABELS: Record<string, string> = {
  "subnet-api": "Subnet API",
  openapi: "OpenAPI spec",
  sse: "Event stream",
  sdk: "SDK",
  "data-artifact": "Data artifact",
  docs: "Docs",
  "source-repo": "Source repo",
  "repo-registry": "Repo registry",
  dashboard: "Dashboard",
  website: "Website",
  example: "Example",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/**
 * What this subnet actually exposes, by kind.
 *
 * Counts of distinct surfaces are additive and share one unit, so unlike the
 * subnet's economics they genuinely divide a whole. This is the composition
 * this page can honestly draw, and it answers the question a builder arrives
 * with: is there anything here I can call?
 */
export function SubnetSurfaceMix({ netuid }: { netuid: number }) {
  const { data } = useSuspenseQuery(subnetSurfacesQuery(netuid));

  const slices = useMemo<CompositionSlice[]>(() => {
    const byKind = new Map<string, number>();
    for (const surface of data.data ?? []) {
      const kind = typeof surface.kind === "string" ? surface.kind : "";
      if (!kind) continue;
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    return [...byKind.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, count]) => ({
        id: kind,
        label: kindLabel(kind),
        value: count,
        valueLabel: formatNumber(count),
      }));
  }, [data.data]);

  if (slices.length === 0) return null;

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  return (
    <CompositionBreakdown
      ariaLabel={`Public surfaces this subnet publishes, by kind, across ${total} surfaces`}
      slices={slices}
      footnote={`${formatNumber(total)} verified public surface${total === 1 ? "" : "s"}`}
    />
  );
}
