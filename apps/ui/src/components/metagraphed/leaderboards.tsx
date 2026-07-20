import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { leaderboardsQuery } from "@/lib/metagraphed/queries";
import {
  ECONOMIC_BOARD_KEYS,
  OPERATIONAL_BOARD_KEYS,
  REGISTRY_BOARD_SPECS,
} from "@/lib/metagraphed/registry-leaderboard-boards";
import { BrandIcon } from "@jsonbored/ui-kit";
import type { LeaderboardBoardKey, LeaderboardRow } from "@/lib/metagraphed/types";

// #1111 / #6995: surface live registry leaderboards (/api/v1/registry/leaderboards)
// as a homepage discovery module. Economic opportunity boards are listed first;
// operational boards follow. Self-contained: the whole section hides on
// error/empty so a discovery extra never breaks the homepage.

const ROWS_PER_BOARD = 5;

const HOMEPAGE_BOARD_KEYS: LeaderboardBoardKey[] = [
  ...ECONOMIC_BOARD_KEYS,
  ...OPERATIONAL_BOARD_KEYS,
];

export function LeaderboardsModule() {
  const { data: res, isError } = useQuery(leaderboardsQuery());
  const boards = res?.data;

  if (isError || !boards) return null;
  const populated = HOMEPAGE_BOARD_KEYS.map((key) => {
    const spec = REGISTRY_BOARD_SPECS[key];
    return {
      key,
      label: spec.label,
      metric: spec.primaryMetric,
      rows: (boards[key] ?? []).slice(0, ROWS_PER_BOARD),
    };
  }).filter((board) => board.rows.length > 0);
  if (populated.length === 0) return null;

  return (
    <section className="mt-section-gap">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted inline-flex items-center gap-2">
            <span className="mg-live-dot" />
            Discover
          </div>
          <h2 className="mt-2 font-display text-2xl md:text-3xl font-semibold tracking-tight text-ink-strong">
            Top subnets, ranked live.
          </h2>
          <p className="mt-2 text-sm text-ink-muted leading-relaxed">
            Registry leaderboards from live data — open slots, registration cost, emission share,
            validator headroom, uptime, completeness, and more.
          </p>
        </div>
        <Link
          to="/leaderboards"
          search={{ view: "opportunity", window: "7d" }}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-accent-text hover:underline"
        >
          View all leaderboards
        </Link>
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
    <div className="rounded-xl border border-border bg-card p-4">
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
    </div>
  );
}
