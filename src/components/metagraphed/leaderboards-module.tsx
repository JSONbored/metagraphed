import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Activity, Sparkles, Zap, Gauge, ArrowRight } from "lucide-react";
import { leaderboardsQuery } from "@/lib/metagraphed/queries";
import type { LeaderboardBoardKey, LeaderboardRow } from "@/lib/metagraphed/types";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import { SectionAnchor } from "@/components/metagraphed/section-anchor";
import { BrandIcon } from "@/components/metagraphed/brand-icon";
import { EntityHoverCard } from "@/components/metagraphed/entity-hover-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const BOARDS: Array<{
  id: LeaderboardBoardKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  metric: string;
  secondary: string;
}> = [
  { id: "healthiest", label: "Healthiest", icon: Activity, metric: "uptime", secondary: "Latency" },
  { id: "fastest-rpc", label: "Fastest RPC", icon: Zap, metric: "p50 ms", secondary: "p99" },
  {
    id: "most-complete",
    label: "Most complete",
    icon: Gauge,
    metric: "completeness",
    secondary: "Surfaces",
  },
  {
    id: "most-enriched",
    label: "Most enriched",
    icon: Sparkles,
    metric: "surfaces",
    secondary: "Sources",
  },
  {
    id: "fastest-growing",
    label: "Fastest growing",
    icon: TrendingUp,
    metric: "30d Δ",
    secondary: "30d",
  },
];

interface MetricView {
  /** Primary metric label rendered on the right with sparkline+bar. */
  primary: string;
  /** Optional inline bar fill 0–1 (null = hide bar). */
  fillPct: number | null;
  /** Tone for the bar (mint / amber / red / muted). */
  tone: "ok" | "warn" | "down" | "muted";
  /** Secondary right-aligned chip text + label (null = hide). */
  secondary: { value: string; label: string } | null;
}

/** Pick the metric field that's populated for this board (see LeaderboardRow). */
function metricValueFor(row: LeaderboardRow, boardId: LeaderboardBoardKey): number | undefined {
  switch (boardId) {
    case "healthiest":
      return row.uptime_ratio;
    case "fastest-rpc":
      return row.latency_ms;
    case "most-complete":
      return row.completeness_score;
    case "most-enriched":
      return row.surface_count;
    case "fastest-growing":
      return row.completeness_delta;
    default:
      return undefined;
  }
}

function viewFor(row: LeaderboardRow, boardId: LeaderboardBoardKey): MetricView {
  const raw = metricValueFor(row, boardId);
  const num = typeof raw === "number" && Number.isFinite(raw) ? raw : null;

  if (boardId === "healthiest") {
    const pct = num == null ? null : num <= 1 ? num * 100 : num;
    const tone: MetricView["tone"] =
      pct == null ? "muted" : pct >= 95 ? "ok" : pct >= 80 ? "warn" : "down";
    return {
      primary: pct == null ? "—" : `${pct.toFixed(1)}%`,
      fillPct: pct == null ? null : Math.max(0, Math.min(1, pct / 100)),
      tone,
      secondary: null,
    };
  }
  if (boardId === "fastest-rpc") {
    const ms = num == null ? null : Math.round(num);
    // Fast = low; map 0–500ms to 1–0
    const fill = ms == null ? null : Math.max(0, Math.min(1, 1 - ms / 500));
    const tone: MetricView["tone"] =
      ms == null ? "muted" : ms <= 100 ? "ok" : ms <= 250 ? "warn" : "down";
    return {
      primary: ms == null ? "—" : `${ms} ms`,
      fillPct: fill,
      tone,
      secondary: null,
    };
  }
  if (boardId === "most-complete") {
    const pct = num == null ? null : num <= 1 ? num * 100 : num;
    const tone: MetricView["tone"] =
      pct == null ? "muted" : pct >= 80 ? "ok" : pct >= 50 ? "warn" : "down";
    return {
      primary: pct == null ? "—" : `${Math.round(pct)}%`,
      fillPct: pct == null ? null : Math.max(0, Math.min(1, pct / 100)),
      tone,
      secondary: null,
    };
  }
  if (boardId === "fastest-growing") {
    const v = num;
    return {
      primary: v == null ? "—" : `${v > 0 ? "+" : ""}${formatNumber(v)}`,
      fillPct: null,
      tone: v == null ? "muted" : v >= 0 ? "ok" : "down",
      secondary: null,
    };
  }
  // most-enriched + default
  return {
    primary: num == null ? "—" : formatNumber(num),
    fillPct: null,
    tone: num == null ? "muted" : "ok",
    secondary: null,
  };
}

const BAR_TONE: Record<MetricView["tone"], string> = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  down: "bg-health-down",
  muted: "bg-ink-subtle/40",
};

export function LeaderboardsModule() {
  const [active, setActive] = useState<LeaderboardBoardKey>("healthiest");
  const { data, isLoading, isError, error, refetch } = useQuery(leaderboardsQuery());
  const boards = data?.data;
  const rows = boards?.[active] ?? [];
  const total = (boards?.["healthiest"] ?? rows).length;

  return (
    <TooltipProvider delayDuration={150}>
      <SectionAnchor
        id="leaderboards"
        title="Discover by leaderboard"
        subtitle="Top subnets across health, RPC latency, completeness, enrichment and growth — derived from the live registry."
        info="GET /api/v1/registry/leaderboards"
      >
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
          {/* Tab strip — equal-flex segmented control with animated underline */}
          <div role="tablist" className="flex border-b border-border">
            {BOARDS.map((b) => {
              const Icon = b.icon;
              const isActive = b.id === active;
              return (
                <button
                  key={b.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActive(b.id)}
                  className={classNames(
                    "mg-lb-tab group relative flex-1 inline-flex items-center justify-center gap-2 px-3 py-3.5 text-[11px] font-medium font-mono uppercase tracking-wider transition-colors",
                    isActive
                      ? "bg-ink-strong text-paper"
                      : "text-ink-muted hover:text-ink-strong hover:bg-surface/60",
                  )}
                >
                  <Icon
                    className={classNames(
                      "size-3.5 transition-transform duration-200",
                      "group-hover:scale-110",
                    )}
                  />
                  <span className="hidden sm:inline">{b.label}</span>
                  {/* Animated hover underline (idle tabs only) */}
                  {!isActive && (
                    <span
                      aria-hidden
                      className="mg-lb-tab-underline pointer-events-none absolute inset-x-3 bottom-1 h-px origin-center scale-x-0 bg-ink-strong opacity-0 transition-transform duration-200"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Rows */}
          <div className="divide-y divide-border/60">
            {isLoading ? (
              <div className="p-3 space-y-2" aria-busy="true" aria-live="polite">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="grid items-center gap-3 px-2 py-2
                               grid-cols-[28px_44px_minmax(0,1fr)_72px_140px]
                               sm:grid-cols-[32px_52px_minmax(0,1fr)_88px_180px]"
                  >
                    <Skeleton className="h-3 w-5" />
                    <Skeleton className="h-3 w-10" />
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="h-5 w-5 rounded-md" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="hidden sm:block h-4 w-16" />
                    <div className="flex items-center justify-end gap-2.5">
                      <Skeleton className="hidden sm:block h-1.5 w-20 rounded-full" />
                      <Skeleton className="h-3 w-10" />
                    </div>
                  </div>
                ))}
              </div>
            ) : isError ? (
              <div className="p-4">
                <ErrorState error={error} onRetry={() => refetch()} context="leaderboards" />
              </div>
            ) : rows.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  title="No leaderboard data"
                  description="The registry hasn't published a board for this category yet."
                  action={{ label: "Browse all subnets", href: "/subnets" }}
                />
              </div>
            ) : (
              <ol className="mg-leaderboard-list">
                {rows.slice(0, 10).map((row, i) => (
                  <LeaderboardRowItem
                    key={`${active}-${row.netuid}-${i}`}
                    row={row}
                    rank={i + 1}
                    boardId={active}
                    index={i}
                  />
                ))}
              </ol>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-border bg-surface/30">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              {rows.length > 0
                ? `Showing top ${Math.min(10, rows.length)} of ${total > 0 ? total : "—"}`
                : "Awaiting registry snapshot"}
            </span>
            <Link
              to="/subnets"
              className="mg-lb-foot-link inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-widest text-ink-strong hover:text-accent transition-colors"
            >
              View all rankings
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </SectionAnchor>
    </TooltipProvider>
  );
}

function LeaderboardRowItem({
  row,
  rank,
  boardId,
  index,
}: {
  row: LeaderboardRow;
  rank: number;
  boardId: LeaderboardBoardKey;
  index: number;
}) {
  const v = viewFor(row, boardId);
  const name = row.name ?? row.slug ?? `Subnet ${row.netuid}`;
  // The leaderboard API carries no per-row trend series, so there is nothing
  // honest to draw a sparkline from — render the metric bar/value only.

  return (
    <li className="mg-leaderboard-row" style={{ animationDelay: `${Math.min(index * 28, 250)}ms` }}>
      <EntityHoverCard kind="subnet" netuid={row.netuid}>
        <Link
          to="/subnets/$netuid"
          params={{ netuid: row.netuid }}
          className="group grid items-center gap-3 px-4 sm:px-5 py-3 transition-colors hover:bg-surface/60
                     grid-cols-[28px_44px_minmax(0,1fr)_72px_140px]
                     sm:grid-cols-[32px_52px_minmax(0,1fr)_88px_180px]"
        >
          {/* Rank */}
          <span className="font-mono text-[11px] tabular-nums text-ink-subtle group-hover:text-ink-strong transition-colors">
            {String(rank).padStart(2, "0")}
          </span>

          {/* Netuid */}
          <span className="font-mono text-[11px] tabular-nums text-ink-muted">
            SN {String(row.netuid).padStart(3, "0")}
          </span>

          {/* Brand + name */}
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandIcon
              size={22}
              netuid={row.netuid}
              subnetSlug={row.slug ?? null}
              name={name}
              fallback={row.netuid}
              className="shrink-0 rounded-md"
            />
            <span className="truncate text-sm font-medium text-ink-strong group-hover:text-accent transition-colors">
              {name}
            </span>
          </div>

          {/* Sparkline column intentionally empty — the board API exposes no
            per-row trend series, and synthesizing one would be fabricated. */}
          <div className="hidden sm:flex items-center" aria-hidden />

          {/* Metric: bar + value (with graceful missing-value tooltip) */}
          <div className="flex items-center justify-end gap-2.5">
            {v.fillPct != null && (
              <div className="hidden sm:block h-1.5 w-20 rounded-full bg-ink-subtle/20 overflow-hidden">
                <div
                  className={classNames(
                    "h-full rounded-full transition-[width] duration-500",
                    BAR_TONE[v.tone],
                  )}
                  style={{ width: `${Math.max(4, v.fillPct * 100)}%` }}
                />
              </div>
            )}
            {v.primary === "—" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="mg-lb-value mg-lb-value-missing inline-flex items-center gap-1 font-mono text-xs font-semibold tabular-nums whitespace-nowrap text-ink-subtle decoration-dotted underline underline-offset-4 decoration-ink-subtle/60 cursor-help"
                    aria-label="Metric unavailable"
                    onClick={(e) => e.preventDefault()}
                  >
                    —
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[240px] text-[11px] leading-relaxed">
                  The registry hasn't published a{" "}
                  <span className="font-mono">{BOARDS.find((b) => b.id === boardId)?.metric}</span>{" "}
                  value for this subnet yet. The ranking still applies — the underlying score is
                  computed upstream — but the per-row metric will appear once the next snapshot
                  lands.
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={classNames(
                  "mg-lb-value font-mono text-xs font-semibold tabular-nums whitespace-nowrap",
                  v.tone === "ok" && "text-health-ok",
                  v.tone === "warn" && "text-health-warn",
                  v.tone === "down" && "text-health-down",
                  v.tone === "muted" && "text-ink-muted",
                )}
              >
                {v.primary}
              </span>
            )}
          </div>
        </Link>
      </EntityHoverCard>
    </li>
  );
}
