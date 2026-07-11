import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { registrySummaryQuery, coverageDepthQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { InfoTooltip, TableState } from "@jsonbored/ui-kit";
import { BarMini, type BarMiniDatum } from "@/components/metagraphed/charts/bar-mini";
import { SortHeader, ariaSort } from "@/components/metagraphed/table-controls";
import type { CoverageDepthQueueRow } from "@/lib/metagraphed/types";

/* ------------------------------------------------------------------ *
 * #5a — registry completeness score distribution (histogram)
 * Fed by /api/v1/registry/summary → coverage.score_distribution, the
 * pre-bucketed { "0-24", "25-49", "50-74", "75-99", "100" } counts.
 * ------------------------------------------------------------------ */

// Canonical bin order + display label. The artifact keys "100" and "0-24" both
// appear; render them in ascending completeness.
const SCORE_BINS = [
  { key: "0-24", label: "0–24" },
  { key: "25-49", label: "25–49" },
  { key: "50-74", label: "50–74" },
  { key: "75-99", label: "75–99" },
  { key: "100", label: "100" },
] as const;

export function RegistryScoreHistogram({ className }: { className?: string }) {
  const { data: res } = useSuspenseQuery(registrySummaryQuery());
  const cov = res.data.coverage;
  const dist = cov.score_distribution;

  const bins = SCORE_BINS.map((b) => ({ ...b, value: dist[b.key] ?? 0 }));
  const max = Math.max(1, ...bins.map((b) => b.value));
  const W = 480;
  const H = 132;
  const PAD = 24;
  const innerW = W - PAD * 2;
  const innerH = H - PAD - 18;
  const colW = innerW / bins.length;
  const scored = cov.scored_subnet_count;

  return (
    <div className={classNames("rounded-lg border border-border bg-card p-5", className)}>
      <header className="mb-2 flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Completeness
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            Score distribution
          </h3>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] text-ink-muted">
          {cov.median_score != null ? <Stat label="p50" value={`${cov.median_score}`} /> : null}
          {cov.average_score != null ? <Stat label="μ" value={`${cov.average_score}`} /> : null}
          <InfoTooltip label="Per-subnet completeness_score (0–100) bucketed by /api/v1/registry/summary. The rightmost bin (100) is the fully-complete set." />
        </div>
      </header>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        role="img"
        aria-label="Registry completeness score distribution"
      >
        {bins.map((b, i) => {
          const x = PAD + i * colW;
          const h = (b.value / max) * innerH;
          const isFull = b.key === "100";
          return (
            <g key={b.key}>
              <title>{`${b.label}: ${b.value} subnets`}</title>
              <rect
                x={x + 2}
                y={PAD + innerH - h}
                width={colW - 4}
                height={h}
                fill={isFull ? "var(--health-ok)" : "var(--accent)"}
                opacity={isFull ? 0.85 : 0.75}
                rx={1.5}
              />
              <text
                x={x + colW / 2}
                y={PAD + innerH - h - 4}
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill="var(--ink-strong)"
              >
                {b.value || ""}
              </text>
              <text
                x={x + colW / 2}
                y={H - 6}
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill="var(--ink-muted)"
              >
                {b.label}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-1 font-mono text-[10px] text-ink-muted">
        {scored != null ? `${scored} subnets scored.` : ""} Each bin is a completeness band; the
        goal is to push the registry rightward.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="uppercase tracking-widest">{label}</span>
      <span className="tabular-nums text-ink-strong">{value}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * #5b — dimension coverage (docs vs openapi vs sse … coverage %)
 * Fed by /api/v1/registry/summary → coverage.dimension_coverage, the
 * registry-wide { dimension: { pct, present } } rollup. Rendered as a
 * BarMini distribution coloured by coverage band.
 * ------------------------------------------------------------------ */

// Stable display order, most-fundamental first; unknown keys append after.
const DIMENSION_ORDER = [
  "docs",
  "source-repo",
  "website",
  "community",
  "openapi",
  "subnet-api",
  "data-artifact",
  "sse",
];

function dimensionColor(pct: number): string {
  if (pct >= 75) return "var(--health-ok)";
  if (pct >= 40) return "var(--chart-3)";
  if (pct >= 15) return "var(--health-warn)";
  return "var(--health-down)";
}

export function DimensionCoverageHeatmap({ className }: { className?: string }) {
  const { data: res } = useSuspenseQuery(registrySummaryQuery());
  const dims = res.data.coverage.dimension_coverage;

  const keys = useMemo(() => {
    const present = Object.keys(dims);
    const ordered = DIMENSION_ORDER.filter((k) => present.includes(k));
    const extra = present.filter((k) => !DIMENSION_ORDER.includes(k)).sort();
    return [...ordered, ...extra];
  }, [dims]);

  const data: BarMiniDatum[] = keys.map((k) => {
    const pct = dims[k]?.pct ?? 0;
    return { label: k, value: pct, color: dimensionColor(pct) };
  });
  const subnetCount = res.data.subnet_count;

  return (
    <div className={classNames("rounded-lg border border-border bg-card p-5", className)}>
      <header className="mb-4 flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Coverage
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            Surface dimensions
          </h3>
        </div>
        <InfoTooltip label="Share of subnets with at least one surface of each kind, registry-wide (/api/v1/registry/summary). Green ≥75%, amber/red are the enrichment frontier." />
      </header>
      <BarMini data={data} max={100} showValue />
      <div className="mt-3 flex items-center justify-between font-mono text-[10px] text-ink-muted">
        <span>% of {subnetCount ?? "all"} subnets covered</span>
        <span className="inline-flex items-center gap-2">
          <Swatch color="var(--health-ok)" label="≥75" />
          <Swatch color="var(--chart-3)" label="≥40" />
          <Swatch color="var(--health-warn)" label="≥15" />
          <Swatch color="var(--health-down)" label="<15" />
        </span>
      </div>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block size-2 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * #5c — enrichment queue (ranked) table
 * Fed by /api/v1/coverage-depth → ranked_queue. The highest-priority
 * subnets to enrich next, with the recommended action + gap codes.
 * ------------------------------------------------------------------ */

const SEVERITY_TONE: Record<string, string> = {
  "needs-review": "text-health-warn border-health-warn/40",
  blocked: "text-health-down border-health-down/40",
  ready: "text-health-ok border-health-ok/40",
};

export function EnrichmentQueueTable({ limit = 12 }: { limit?: number }) {
  const { data: res } = useSuspenseQuery(coverageDepthQuery());
  const [sort, setSort] = useState<"rank" | "priority_score" | "score">("rank");
  const [order, setOrder] = useState<"asc" | "desc">("asc");

  const onSort = (field: string) => {
    const f = field as typeof sort;
    if (f === sort) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(f);
      setOrder(f === "rank" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const list = [...res.data.ranked_queue];
    const mul = order === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const va = a[sort] ?? 0;
      const vb = b[sort] ?? 0;
      return (Number(va) - Number(vb)) * mul;
    });
    return list.slice(0, limit);
  }, [res.data.ranked_queue, sort, order, limit]);

  if (res.data.ranked_queue.length === 0) {
    return (
      <TableState
        variant="empty"
        title="Enrichment queue is empty"
        description="No subnets are currently queued for enrichment — the coverage-depth artifact returned no ranked rows."
        generatedAt={res.meta?.generated_at}
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface/50 text-[10px] font-mono uppercase tracking-widest text-ink-muted">
          <tr>
            <th className="px-3 py-2.5" aria-sort={ariaSort(sort === "rank", order)}>
              <SortHeader
                label="#"
                field="rank"
                active={sort === "rank"}
                order={order}
                onSort={onSort}
              />
            </th>
            <th className="px-3 py-2.5">Subnet</th>
            <th className="px-3 py-2.5">Severity</th>
            <th
              className="px-3 py-2.5 text-right"
              aria-sort={ariaSort(sort === "priority_score", order)}
            >
              <SortHeader
                label="Priority"
                field="priority_score"
                active={sort === "priority_score"}
                order={order}
                onSort={onSort}
                align="right"
              />
            </th>
            <th className="px-3 py-2.5 text-right" aria-sort={ariaSort(sort === "score", order)}>
              <SortHeader
                label="Score"
                field="score"
                active={sort === "score"}
                order={order}
                onSort={onSort}
                align="right"
              />
            </th>
            <th className="px-3 py-2.5">Recommended next action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <QueueRow key={r.netuid} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueueRow({ row }: { row: CoverageDepthQueueRow }) {
  const tone = SEVERITY_TONE[row.severity ?? ""] ?? "text-ink-muted border-border";
  return (
    <tr className="mg-row-hover">
      <td className="px-3 py-2.5 font-mono text-[11px] tabular-nums text-ink-muted">{row.rank}</td>
      <td className="px-3 py-2.5">
        <Link
          to="/subnets/$netuid"
          params={{ netuid: row.netuid }}
          className="inline-flex items-center gap-2 font-medium text-ink-strong hover:underline"
        >
          <span className="font-mono text-[11px] text-ink-muted">
            #{String(row.netuid).padStart(3, "0")}
          </span>
          <span className="truncate">{row.name ?? `Subnet ${row.netuid}`}</span>
        </Link>
      </td>
      <td className="px-3 py-2.5">
        {row.severity ? (
          <span
            className={classNames(
              "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
              tone,
            )}
          >
            {row.severity}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-strong">
        {row.priority_score ?? "—"}
      </td>
      <td className="px-3 py-2.5 text-right font-mono text-[11px] tabular-nums text-ink-muted">
        {row.score ?? "—"}
      </td>
      <td className="px-3 py-2.5 text-[12px] text-ink">
        <span className="line-clamp-1" title={row.recommended_next_action}>
          {row.recommended_next_action ?? "—"}
        </span>
        {row.top_gap_codes && row.top_gap_codes.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.top_gap_codes.slice(0, 4).map((g) => (
              <span
                key={g}
                className="rounded border border-dashed border-ink-subtle bg-paper px-1 py-0.5 font-mono text-[9px] text-ink-muted"
              >
                {g}
              </span>
            ))}
          </div>
        ) : null}
      </td>
    </tr>
  );
}
