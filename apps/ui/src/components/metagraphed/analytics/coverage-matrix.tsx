import { Definition, DataTable, type DataTableColumn } from "@jsonbored/ui-kit";
import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { reviewProfileCompletenessQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";
import { RouterLink } from "@/components/metagraphed/router-link";
import type { Subnet } from "@/lib/metagraphed/types";

const KINDS = [
  "docs",
  "repo",
  "openapi",
  "endpoint",
  "dashboard",
  "data",
  "sdk",
  "example",
  "rpc",
] as const;
type Kind = (typeof KINDS)[number];

type Cell = "present" | "candidate" | "missing" | "unknown";

const CELL_TONE: Record<Cell, { bg: string; ring: string; label: string }> = {
  present: { bg: "bg-health-ok/70 hover:bg-health-ok", ring: "ring-health-ok", label: "Present" },
  candidate: {
    bg: "bg-health-warn/70 hover:bg-health-warn",
    ring: "ring-health-warn",
    label: "Candidate (unverified)",
  },
  missing: {
    bg: "bg-health-down/40 hover:bg-health-down/70",
    ring: "ring-health-down",
    label: "Missing",
  },
  unknown: { bg: "bg-border/40 hover:bg-border", ring: "ring-border", label: "Unknown" },
};

/** One subnet row of the matrix: its metadata plus a verdict per kind. */
interface MatrixRow {
  netuid: number;
  name: string;
  completeness: number;
  missingCount: number;
  cells: Record<Kind, Cell>;
}

/** One kind's verdict, as a link to that subnet. */
function CellLink({ row, kind }: { row: MatrixRow; kind: Kind }) {
  const tone = CELL_TONE[row.cells[kind]];
  return (
    <Link
      to="/subnets/$netuid"
      params={{ netuid: row.netuid }}
      className={classNames(
        "block h-6 w-full rounded transition-all hover:ring-2",
        tone.bg,
        tone.ring,
      )}
      title={`${tone.label} · ${kind} · SN${row.netuid}`}
    >
      <span className="sr-only">{`${kind} ${tone.label}`}</span>
    </Link>
  );
}

const MATRIX_COLUMNS: Array<DataTableColumn<MatrixRow>> = [
  {
    key: "subnet",
    label: "Subnet",
    sortable: true,
    value: (r) => r.name,
    render: (r) => (
      <Link
        to="/subnets/$netuid"
        params={{ netuid: r.netuid }}
        className="inline-flex min-w-0 items-center gap-1.5 hover:text-accent"
      >
        <span className="text-10 text-ink-muted">SN{r.netuid}</span>
        <span className="truncate">{r.name}</span>
      </Link>
    ),
  },
  ...KINDS.map<DataTableColumn<MatrixRow>>((k) => ({
    key: k,
    label: k,
    align: "left" as const,
    value: (r: MatrixRow) => CELL_TONE[r.cells[k]].label,
    render: (r: MatrixRow) => <CellLink row={r} kind={k} />,
  })),
  {
    key: "completeness",
    label: "Comp",
    kind: "number",
    sortable: true,
    value: (r) => r.completeness,
    format: (v) => `${Math.round((typeof v === "number" ? v : 0) * 100)}%`,
  },
];

const SORT_OPTIONS = [
  { v: "missing-desc", label: "Most missing" },
  { v: "missing-asc", label: "Most complete" },
  { v: "netuid", label: "By netuid" },
] as const;

/**
 * Coverage matrix: subnets (rows) × required resource kinds (cols). Cells
 * encode whether the kind is verified, only present as a candidate, or
 * missing. Each cell links straight to that subnet's profile tab.
 *
 * Heavy lifting: we read /review/profile-completeness for the per-subnet
 * `missing` array, and cross-reference /subnets/:netuid/candidates only for
 * the top rows (lazy via Suspense boundaries kept upstream).
 */
export function CoverageMatrix({ topN = 24 }: { topN?: number }) {
  const { data: cRes } = useSuspenseQuery(reviewProfileCompletenessQuery());
  const { data: sRes } = useSuspenseQuery(subnetsQuery({ limit: 250 }));
  const profiles = useMemo(() => cRes.data ?? [], [cRes.data]);
  const subnets = useMemo(() => (sRes.data ?? []) as Subnet[], [sRes.data]);

  const [sort, setSort] = useState<"missing-desc" | "missing-asc" | "netuid">("missing-desc");

  // Lookup table: subnet metadata + the canonical missing-kinds array.
  const rows = useMemo<MatrixRow[]>(() => {
    const subnetByNetuid = new Map<number, Subnet>();
    for (const s of subnets) subnetByNetuid.set(s.netuid as number, s);

    const out = profiles.map((p) => {
      const subnet = subnetByNetuid.get(p.netuid);
      const missing = new Set((p.missing ?? []).map((m) => m.toLowerCase()));
      const cells: Record<Kind, Cell> = {} as Record<Kind, Cell>;
      for (const k of KINDS) {
        cells[k] = missing.has(k) ? "missing" : (p.completeness ?? 0) > 0 ? "present" : "unknown";
      }
      return {
        netuid: p.netuid,
        name: subnet?.name ?? `SN${p.netuid}`,
        completeness: p.completeness ?? 0,
        missingCount: missing.size,
        cells,
      };
    });

    if (sort === "missing-desc")
      out.sort((a, b) => b.missingCount - a.missingCount || a.netuid - b.netuid);
    else if (sort === "missing-asc")
      out.sort((a, b) => a.missingCount - b.missingCount || a.netuid - b.netuid);
    else out.sort((a, b) => a.netuid - b.netuid);

    return out.slice(0, topN);
  }, [profiles, subnets, sort, topN]);

  const totals = useMemo(() => {
    const t: Record<Cell, number> = { present: 0, candidate: 0, missing: 0, unknown: 0 };
    for (const r of rows) for (const k of KINDS) t[r.cells[k]] += 1;
    return t;
  }, [rows]);

  return (
    <div className="space-y-2">
      {/* Eleven columns: at 375px the old grid put the "Comp" column -- the one
          signal separating a 25%-complete subnet from a full one -- behind a
          horizontal scroll nobody makes, so every row read as covered (#5310).
          A labelled card per subnet keeps every kind AND the score on screen,
          which is why the sticky column, the edge fade and the "scroll →" badge
          that used to paper over it are all gone. */}
      <DataTable
        rows={rows}
        columns={MATRIX_COLUMNS}
        rowKey={(r) => String(r.netuid)}
        caption="What each subnet is missing"
        link={RouterLink}
        source="coverage-matrix"
        mobile="cards"
        filters={
          <>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setSort(o.v)}
                className={classNames(
                  "inline-flex items-center rounded border px-2 py-0.5 text-13 transition-colors",
                  sort === o.v
                    ? "border-accent/60 bg-accent/10 text-accent"
                    : "border-border text-ink-muted hover:text-ink-strong",
                )}
                aria-pressed={sort === o.v}
              >
                {o.label}
              </button>
            ))}
            <Definition term="Coverage matrix" />
          </>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-10 text-ink-muted">
        <div className="flex items-center gap-3">
          <Legend cell="present" count={totals.present} />
          <Legend cell="candidate" count={totals.candidate} />
          <Legend cell="missing" count={totals.missing} />
          <Legend cell="unknown" count={totals.unknown} />
        </div>
        <div>showing top {rows.length} subnets</div>
      </div>
    </div>
  );
}

function Legend({ cell, count }: { cell: Cell; count: number }) {
  const tone = CELL_TONE[cell];
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={classNames("inline-block size-2 rounded", tone.bg.split(" ")[0])}
        aria-hidden
      />
      <span>{tone.label.toLowerCase()}</span>
      <span className="tabular-nums opacity-75">{count}</span>
    </span>
  );
}

/**
 * Completeness histogram with quartile markers. Pure SVG so we don't
 * pull in a charting dep for a 12-bucket bar chart.
 */
export function CompletenessHistogram() {
  const { data } = useSuspenseQuery(reviewProfileCompletenessQuery());
  const rows = useMemo(() => data.data ?? [], [data.data]);

  const buckets = useMemo(() => {
    const arr = new Array(10).fill(0) as number[];
    for (const r of rows) {
      const v = Math.min(1, Math.max(0, r.completeness ?? 0));
      const idx = Math.min(9, Math.floor(v * 10));
      arr[idx]! += 1;
    }
    return arr;
  }, [rows]);

  const stats = useMemo(() => {
    const vals = rows.map((r) => r.completeness ?? 0).sort((a, b) => a - b);
    if (!vals.length) return null;
    const pct = (p: number) => vals[Math.floor(p * (vals.length - 1))]!;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), mean };
  }, [rows]);

  const max = Math.max(1, ...buckets);
  const W = 480;
  const H = 132;
  const PAD = 24;
  const innerW = W - PAD * 2;
  const innerH = H - PAD - 18;
  const colW = innerW / buckets.length;

  return (
    <Panel>
      <header className="flex items-center justify-between mb-2">
        <div>
          <div className="text-13 text-ink-muted">Distribution</div>
          <h3 className="mt-0.5 font-display text-13 font-semibold text-ink-strong">
            Completeness across the registry
          </h3>
        </div>
        {stats ? (
          <div className="flex items-center gap-3 text-10 text-ink-muted">
            <Stat label="p25" value={`${Math.round(stats.p25 * 100)}%`} />
            <Stat label="p50" value={`${Math.round(stats.p50 * 100)}%`} />
            <Stat label="p75" value={`${Math.round(stats.p75 * 100)}%`} />
            <Stat label="μ" value={`${Math.round(stats.mean * 100)}%`} />
          </div>
        ) : null}
      </header>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block w-full"
        role="img"
        aria-label="Completeness distribution across the registry"
      >
        {buckets.map((c, i) => {
          const x = PAD + i * colW;
          const h = (c / max) * innerH;
          return (
            <g key={i}>
              <rect
                x={x + 1}
                y={PAD + innerH - h}
                width={colW - 2}
                height={h}
                fill="var(--accent)"
                opacity={0.75}
                rx={1.5}
              />
              <text
                x={x + colW / 2}
                y={H - 6}
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize={9}
                fill="var(--ink-muted)"
              >
                {i * 10}%
              </text>
            </g>
          );
        })}
        {stats
          ? (["p25", "p50", "p75"] as const).map((k) => {
              const v = stats[k];
              const x = PAD + v * innerW;
              return (
                <g key={k}>
                  <line
                    x1={x}
                    x2={x}
                    y1={PAD}
                    y2={PAD + innerH}
                    stroke={k === "p50" ? "var(--ink-strong)" : "var(--ink-muted)"}
                    strokeDasharray="2 2"
                    strokeOpacity={k === "p50" ? 0.6 : 0.4}
                  />
                  <text
                    x={x + 3}
                    y={PAD + 9}
                    fontFamily="ui-monospace, monospace"
                    fontSize={9}
                    fill={k === "p50" ? "var(--ink-strong)" : "var(--ink-muted)"}
                  >
                    {k}
                  </text>
                </g>
              );
            })
          : null}
      </svg>
      <p className="mt-1 text-10 text-ink-muted">
        {rows.length} subnets bucketed in 10% bins. Median (p50) marks the middle of the registry;
        long tail to the right is the goal.
      </p>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="">{label}</span>
      <span className="text-ink-strong tabular-nums">{value}</span>
    </span>
  );
}
