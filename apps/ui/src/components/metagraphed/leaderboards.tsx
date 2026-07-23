import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { leaderboardsQuery } from "@/lib/metagraphed/queries";
import { BrandIcon } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import type { LeaderboardBoardKey, LeaderboardRow } from "@/lib/metagraphed/types";

// #1111: surface the five live, D1-computed registry leaderboards
// (/api/v1/registry/leaderboards) as a homepage discovery module. Each board's
// ranked rows link straight to the subnet detail page. Self-contained: the whole
// section hides on error/empty so a discovery extra never breaks the homepage.

const ROWS_PER_BOARD = 5;

const BOARDS: Array<{
  key: LeaderboardBoardKey;
  label: string;
  metric: (row: LeaderboardRow) => string | null;
}> = [
  {
    key: "healthiest",
    label: "Healthiest",
    metric: (r) => (r.uptime_ratio != null ? `${Math.round(r.uptime_ratio * 100)}% up` : null),
  },
  {
    key: "fastest-rpc",
    label: "Fastest RPC",
    metric: (r) => (r.latency_ms != null ? `${Math.round(r.latency_ms)}ms` : null),
  },
  {
    key: "most-complete",
    label: "Most complete",
    metric: (r) => (r.completeness_score != null ? `${Math.round(r.completeness_score)}%` : null),
  },
  {
    key: "most-enriched",
    label: "Most enriched",
    metric: (r) =>
      r.surface_count != null
        ? `${r.surface_count} surface${r.surface_count === 1 ? "" : "s"}`
        : null,
  },
  {
    key: "fastest-growing",
    label: "Fastest growing",
    metric: (r) =>
      r.completeness_delta != null ? `+${Math.round(r.completeness_delta)} pts` : null,
  },
];

export function LeaderboardsModule() {
  const { data: res, isError } = useQuery(leaderboardsQuery());
  const boards = res?.data;

  // Discovery extra — never break the homepage. Hide entirely on error, and until
  // at least one board has rows to show.
  if (isError || !boards) return null;
  const populated = BOARDS.map((board) => ({
    ...board,
    rows: (boards[board.key] ?? []).slice(0, ROWS_PER_BOARD),
  })).filter((board) => board.rows.length > 0);
  if (populated.length === 0) return null;

  return (
    <section className="mt-section-gap">
      <div className="mb-8 max-w-2xl">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted inline-flex items-center gap-2">
          <span className="mg-live-dot" />
          Discover
        </div>
        <h2 className="mt-2 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
          Top subnets, ranked live.
        </h2>
        <p className="mt-2 text-sm text-ink-muted leading-relaxed">
          Five leaderboards computed from live registry data — by uptime, RPC latency, interface
          completeness, surface coverage, and recent growth.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {populated.map((board) => (
          <BoardCard key={board.key} label={board.label} rows={board.rows} metric={board.metric} />
        ))}
      </div>
    </section>
  );
}

function BoardCard({
  label,
  rows,
  metric,
}: {
  label: string;
  rows: LeaderboardRow[];
  metric: (row: LeaderboardRow) => string | null;
}) {
  return (
    <Panel as="div" dense>
      <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </div>
      <ol className="space-y-0.5">
        {rows.map((row, i) => (
          <li key={row.netuid}>
            <Link
              to="/subnets/$netuid"
              params={{ netuid: row.netuid }}
              className="mg-row-hover flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-ink-muted tabular-nums">
                  {i + 1}
                </span>
                <BrandIcon
                  size={18}
                  name={row.name ?? `Subnet ${row.netuid}`}
                  fallback={row.netuid}
                  netuid={row.netuid}
                  subnetSlug={row.slug}
                />
                <span className="truncate text-sm text-ink-strong">
                  {row.name ?? `Subnet ${row.netuid}`}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-muted">
                {metric(row) ?? "—"}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
