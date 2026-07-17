import { useMemo, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { reviewProfileCompletenessQuery, subnetsQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { InfoTooltip } from "@jsonbored/ui-kit";
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
  const profiles = cRes.data ?? [];
  const subnets = (sRes.data ?? []) as Subnet[];

  const [sort, setSort] = useState<"missing-desc" | "missing-asc" | "netuid">("missing-desc");

  // Lookup table: subnet metadata + the canonical missing-kinds array.
  const rows = useMemo(() => {
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
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border bg-paper/30">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Coverage matrix
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            What each subnet is missing
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {(
            [
              { v: "missing-desc", label: "Most missing" },
              { v: "missing-asc", label: "Most complete" },
              { v: "netuid", label: "By netuid" },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setSort(o.v)}
              className={classNames(
                "inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                sort === o.v
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-border text-ink-muted hover:text-ink-strong",
              )}
              aria-pressed={sort === o.v}
            >
              {o.label}
            </button>
          ))}
          <InfoTooltip label="Joins /review/profile-completeness with /subnets. Each cell is colored by whether the required public-interface kind is present, missing, or only a candidate." />
        </div>
      </header>

      {/* At 375px only the subnet column + ~4 kind cells fit, and the far-right
          "Comp" column — the signal that actually separates a 25%-complete
          subnet from a full one — scrolls off-screen, so every row reads as
          covered (#5310). Two cues fix that: each row shows its completeness in
          the always-visible sticky column (below, mobile only), and a
          right-edge fade signals there's more to scroll. */}
      <div className="relative">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px] font-mono">
            <thead>
              <tr className="bg-paper/30">
                <th className="sticky left-0 z-10 bg-paper/30 text-left px-3 py-2 text-[10px] uppercase tracking-[0.12em] text-ink-muted border-b border-border">
                  Subnet
                </th>
                {KINDS.map((k) => (
                  <th
                    key={k}
                    className="px-2 py-2 text-center text-[10px] uppercase tracking-[0.12em] text-ink-muted border-b border-border"
                  >
                    {k}
                  </th>
                ))}
                <th className="px-2 py-2 text-right text-[10px] uppercase tracking-[0.12em] text-ink-muted border-b border-border">
                  Comp
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.netuid}
                  className="border-b border-border last:border-b-0 hover:bg-paper/30"
                >
                  <td className="sticky left-0 z-10 bg-card px-3 py-1.5 border-r border-border text-ink-strong">
                    <div className="flex items-center gap-2">
                      <Link
                        to="/subnets/$netuid"
                        params={{ netuid: r.netuid }}
                        className="inline-flex min-w-0 items-center gap-1.5 hover:text-accent"
                      >
                        <span className="font-mono text-[10px] text-ink-muted">SN{r.netuid}</span>
                        <span className="truncate max-w-[110px] sm:max-w-[160px]">{r.name}</span>
                      </Link>
                      <CompletenessChip value={r.completeness} netuid={r.netuid} />
                    </div>
                  </td>
                  {KINDS.map((k) => {
                    const cell = r.cells[k];
                    const tone = CELL_TONE[cell];
                    return (
                      <td key={k} className="p-1 align-middle">
                        <Link
                          to="/subnets/$netuid"
                          params={{ netuid: r.netuid }}
                          search={{ tab: "surfaces" }}
                          className={classNames(
                            "block h-6 w-full rounded transition-all hover:ring-2",
                            tone.bg,
                            tone.ring,
                          )}
                          title={`${tone.label} · ${k} · SN${r.netuid}`}
                        >
                          <span className="sr-only">{`${k} ${tone.label}`}</span>
                        </Link>
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-right tabular-nums text-ink-strong">
                    {Math.round(r.completeness * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-card to-transparent md:hidden"
        />
        <div className="pointer-events-none absolute bottom-1 right-2 rounded bg-ink-strong/70 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-paper md:hidden">
          scroll →
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-paper/30 px-4 py-2 font-mono text-[10px] text-ink-muted">
        <div className="flex items-center gap-3">
          <Legend cell="present" count={totals.present} />
          <Legend cell="candidate" count={totals.candidate} />
          <Legend cell="missing" count={totals.missing} />
          <Legend cell="unknown" count={totals.unknown} />
        </div>
        <div>showing top {rows.length} subnets</div>
      </footer>
    </section>
  );
}

// Always-visible per-row completeness. On mobile the far-right "Comp" column —
// the one signal that actually distinguishes a 25%-complete subnet from a
// 100% one — scrolls off-screen, leaving only the leftmost (usually present)
// kind cells visible, so every row reads as fully covered (#5310). Surfacing
// completeness inside the sticky column (mobile only; the "Comp" column still
// serves md+) makes a low-coverage subnet obvious without scrolling. Coloured
// by tier so an incomplete subnet reads red at a glance.
function CompletenessChip({ value, netuid }: { value: number; netuid: number }) {
  const pct = Math.round(value * 100);
  const tone =
    value >= 0.8
      ? "border-health-ok/40 bg-health-ok/10 text-health-ok"
      : value >= 0.5
        ? "border-health-warn/40 bg-health-warn/10 text-health-warn"
        : "border-health-down/40 bg-health-down/10 text-health-down";
  return (
    <span
      title={`SN${netuid}: ${pct}% of required public-interface kinds present`}
      className={classNames(
        "ml-auto inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 font-mono text-[9px] font-semibold tabular-nums md:hidden",
        tone,
      )}
    >
      {pct}%
    </span>
  );
}

function Legend({ cell, count }: { cell: Cell; count: number }) {
  const tone = CELL_TONE[cell];
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={classNames("inline-block size-2 rounded-sm", tone.bg.split(" ")[0])}
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
  const rows = data.data ?? [];

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
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="flex items-center justify-between mb-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
            Distribution
          </div>
          <h3 className="mt-0.5 font-display text-sm font-semibold text-ink-strong">
            Completeness across the registry
          </h3>
        </div>
        {stats ? (
          <div className="flex items-center gap-3 font-mono text-[10px] text-ink-muted">
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
      <p className="mt-1 font-mono text-[10px] text-ink-muted">
        {rows.length} subnets bucketed in 10% bins. Median (p50) marks the middle of the registry;
        long tail to the right is the goal.
      </p>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="uppercase tracking-[0.12em]">{label}</span>
      <span className="text-ink-strong tabular-nums">{value}</span>
    </span>
  );
}
