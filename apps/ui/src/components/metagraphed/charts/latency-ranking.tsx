import { useMemo } from "react";
import { RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import type { Endpoint } from "@/lib/metagraphed/types";

interface ProviderRow {
  slug: string;
  label: string;
  p50: number;
  count: number;
  byRegion: Array<{ region: string; p50: number }>;
}

/** Prefer real latency_ms, then probe p50, then p95 — never freshness. */
function latencyOf(e: Endpoint): number | undefined {
  const raw = e as Record<string, unknown>;
  const v =
    (typeof e.latency_ms === "number" ? e.latency_ms : undefined) ??
    (typeof raw.latency_p50_ms === "number" ? (raw.latency_p50_ms as number) : undefined) ??
    (typeof raw.latency_p95_ms === "number" ? (raw.latency_p95_ms as number) : undefined);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const formatMs = (ms: number) => `${Math.round(ms)}ms`;

/**
 * Providers ranked by the median latency of their tracked endpoints, slowest
 * first, with per-region medians in the row detail. Providers with no
 * latency sample are left out rather than shown as zero.
 */
export function LatencyRanking({
  endpoints,
  limit = 10,
}: {
  endpoints: Endpoint[];
  limit?: number;
}) {
  const rows = useMemo<ProviderRow[]>(() => {
    const grouped = new Map<string, { label: string; endpoints: Endpoint[] }>();
    for (const e of endpoints) {
      const slug = e.provider_slug ?? e.provider ?? "unknown";
      const entry = grouped.get(slug) ?? { label: e.provider ?? slug, endpoints: [] };
      entry.endpoints.push(e);
      grouped.set(slug, entry);
    }
    const out: ProviderRow[] = [];
    for (const [slug, { label, endpoints: members }] of grouped) {
      const p50 = median(members.map(latencyOf).filter((v): v is number => v !== undefined));
      if (p50 === null) continue;
      const regions = new Map<string, number[]>();
      for (const e of members) {
        const ms = latencyOf(e);
        if (ms === undefined || !e.region) continue;
        regions.set(e.region, [...(regions.get(e.region) ?? []), ms]);
      }
      const byRegion = [...regions]
        .map(([region, values]) => ({ region, p50: median(values)! }))
        .sort((a, b) => b.p50 - a.p50);
      out.push({ slug, label, p50, count: members.length, byRegion });
    }
    return out.sort((a, b) => b.p50 - a.p50);
  }, [endpoints]);

  if (rows.length === 0) {
    return <EmptyState title="No endpoint latency data yet" />;
  }

  const items: RankedRailItem[] = rows.map((r) => ({
    key: `provider:${r.slug}`,
    label: r.label,
    value: r.p50,
    href: `/providers/${r.slug}`,
    detail: [
      { key: "endpoints", label: "endpoints", value: String(r.count) },
      ...r.byRegion.map((x) => ({
        key: `region:${x.region}`,
        label: x.region,
        value: formatMs(x.p50),
      })),
    ],
  }));

  return (
    <RankedRails
      items={items}
      formatValue={formatMs}
      scale="sqrt"
      columns={{ value: "p50", name: "Provider", track: "slowest first" }}
      limit={limit}
      ariaLabel="Providers ranked by median endpoint latency"
      source="latency-ranking"
    />
  );
}
