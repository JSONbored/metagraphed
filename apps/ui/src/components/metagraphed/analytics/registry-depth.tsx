import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { registrySummaryQuery, coverageDepthQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Definition, MarkerRail, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { EmptyState } from "@/components/metagraphed/states";
import { Panel } from "@/components/metagraphed/primitives";
import { RouterLink } from "@/components/metagraphed/router-link";
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
    <Panel flush className={className}>
      <div className="p-4">
        <header className="mb-2 flex items-center justify-between">
          <div>
            <div className="text-13 text-ink-muted">Completeness</div>
            <h3 className="mt-0.5 font-display text-13 font-semibold text-ink-strong">
              Score distribution
            </h3>
          </div>
          <div className="flex items-center gap-3 text-10 text-ink-muted">
            {cov.median_score != null ? <Stat label="p50" value={`${cov.median_score}`} /> : null}
            {cov.average_score != null ? <Stat label="μ" value={`${cov.average_score}`} /> : null}
            <Definition term="Completeness histogram" />
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
        <p className="mt-1 text-10 text-ink-muted">
          {scored != null ? `${scored} subnets scored.` : ""} Each bin is a completeness band; the
          goal is to push the registry rightward.
        </p>
      </div>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="">{label}</span>
      <span className="tabular-nums text-ink-strong">{value}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * #5b — dimension coverage (docs vs openapi vs sse … coverage %)
 * Fed by /api/v1/registry/summary → coverage.dimension_coverage, the
 * registry-wide { dimension: { pct, present } } rollup. Rendered as a
 * marker rail per dimension.
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

export function DimensionCoverageHeatmap({ className }: { className?: string }) {
  const { data: res } = useSuspenseQuery(registrySummaryQuery());
  const dims = res.data.coverage.dimension_coverage;

  const keys = useMemo(() => {
    const present = Object.keys(dims);
    const ordered = DIMENSION_ORDER.filter((k) => present.includes(k));
    const extra = present.filter((k) => !DIMENSION_ORDER.includes(k)).sort();
    return [...ordered, ...extra];
  }, [dims]);

  const data = keys.map((k) => ({ key: k, label: k, value: dims[k]?.pct ?? null }));
  const subnetCount = res.data.subnet_count;

  return (
    <Panel flush className={className}>
      <div className="p-4">
        <header className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-13 text-ink-muted">Coverage</div>
            <h3 className="mt-0.5 font-display text-13 font-semibold text-ink-strong">
              Surface dimensions
            </h3>
          </div>
          <Definition term="Kind coverage" />
        </header>
        <MarkerRail
          items={data}
          max={100}
          formatValue={(v) => `${Math.round(v)}%`}
          columns={{ ratio: "Coverage", name: "Dimension", scale: "0–100%" }}
          ariaLabel={`Surface dimension coverage across ${subnetCount ?? "all"} subnets`}
        />
      </div>
    </Panel>
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

const QUEUE_COLUMNS: Array<DataTableColumn<CoverageDepthQueueRow>> = [
  { key: "rank", label: "#", kind: "number", align: "left", sortable: true, value: (r) => r.rank },
  {
    key: "subnet",
    label: "Subnet",
    sortable: true,
    value: (r) => r.name ?? `Subnet ${r.netuid}`,
    render: (r) => (
      <Link
        to="/subnets/$netuid"
        params={{ netuid: r.netuid }}
        className="inline-flex min-w-0 items-center gap-2 font-medium text-ink-strong hover:underline"
      >
        <span className="text-11 text-ink-muted">#{String(r.netuid).padStart(3, "0")}</span>
        <span className="truncate">{r.name ?? `Subnet ${r.netuid}`}</span>
      </Link>
    ),
  },
  {
    key: "severity",
    label: "Severity",
    sortable: true,
    value: (r) => r.severity ?? null,
    render: (r) =>
      r.severity ? (
        <span
          className={classNames(
            "inline-flex items-center rounded border px-1.5 py-0.5 text-13",
            SEVERITY_TONE[r.severity] ?? "text-ink-muted border-border",
          )}
        >
          {r.severity}
        </span>
      ) : (
        "—"
      ),
  },
  {
    key: "priority_score",
    label: "Priority",
    kind: "number",
    sortable: true,
    value: (r) => r.priority_score ?? null,
  },
  { key: "score", label: "Score", kind: "number", sortable: true, value: (r) => r.score ?? null },
  {
    key: "action",
    label: "Recommended next action",
    value: (r) => r.recommended_next_action ?? null,
    render: (r) => (
      <span className="block min-w-0">
        <span className="line-clamp-1 text-ink">{r.recommended_next_action ?? "—"}</span>
        {r.top_gap_codes && r.top_gap_codes.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {r.top_gap_codes.slice(0, 4).map((g) => (
              <span
                key={g}
                className="rounded border border-dashed border-ink-subtle bg-paper px-1 py-0.5 text-10 text-ink-muted"
              >
                {g}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    ),
  },
];

export function EnrichmentQueueTable({ limit = 12 }: { limit?: number }) {
  const { data: res } = useSuspenseQuery(coverageDepthQuery());

  // The artifact publishes the queue already ranked; the table owns every
  // re-sort from there, so the two orderings can never disagree.
  const rows = useMemo(
    () => [...res.data.ranked_queue].sort((a, b) => a.rank - b.rank).slice(0, limit),
    [res.data.ranked_queue, limit],
  );

  if (res.data.ranked_queue.length === 0) {
    return (
      <EmptyState
        title="Enrichment queue is empty"
        description="No subnets are currently queued for enrichment — the coverage-depth artifact returned no ranked rows."
        lastChecked={res.meta?.generated_at}
      />
    );
  }

  return (
    <DataTable
      rows={rows}
      columns={QUEUE_COLUMNS}
      rowKey={(r) => String(r.netuid)}
      caption="Enrichment queue"
      total={res.data.ranked_queue.length}
      link={RouterLink}
      source="enrichment-queue"
      storageKey="enrichment-queue"
      // The `limit` prop already bounds the slice; a second pager over an
      // already-truncated list would page a page.
      paginate={false}
    />
  );
}
