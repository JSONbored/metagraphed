import { Link } from "@tanstack/react-router";
import { TimeAgo } from "@jsonbored/ui-kit";
import { formatNumber } from "@/lib/metagraphed/format";
import { Panel } from "@/components/metagraphed/primitives";
import type { RuntimeTransition } from "@/lib/metagraphed/types";

/**
 * Backend `/api/v1/runtime` orders transitions ascending by block_number
 * (earliest first); every timeline view on this site displays newest first.
 * Returns a NEW array — the source array (a React Query cache value) must never
 * be reversed in place, or an in-place `.reverse()` would flip the shared cache
 * for the table view and any other reader on re-render.
 */
export function orderRuntimeUpgradesNewestFirst(
  transitions: readonly RuntimeTransition[],
): RuntimeTransition[] {
  return [...transitions].reverse();
}

type RuntimeUpgradeCardListProps = {
  rows: readonly RuntimeTransition[];
  className?: string;
};

/**
 * Mobile card fallback for the runtime spec-version upgrade table (#6334): the
 * 3-column table is undiscoverably clipped behind horizontal scroll on a narrow
 * viewport, so below `md` each upgrade renders as a stacked card instead —
 * mirroring the `md:hidden` card path every other tabular list page provides
 * (validators, leaderboards, providers, ListShell tables).
 */
export function RuntimeUpgradeCardList({ rows, className }: RuntimeUpgradeCardListProps) {
  return (
    <div className={className}>
      {rows.map((row) => (
        <Panel
          as="div"
          dense
          key={`${row.spec_version}-${row.block_number}`}
          className="min-w-0"
          bodyClassName="space-y-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Spec Version
            </span>
            <span className="font-mono text-[13px] tabular-nums text-ink-strong">
              {formatNumber(row.spec_version)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Block
            </span>
            <span className="font-mono text-[12px] tabular-nums">
              {row.block_number != null ? (
                <Link
                  to="/blocks/$ref"
                  params={{ ref: String(row.block_number) }}
                  className="text-ink hover:text-accent hover:underline"
                >
                  #{formatNumber(row.block_number)}
                </Link>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
              Observed
            </span>
            <span className="font-mono text-[12px] text-ink-muted">
              {row.observed_at ? <TimeAgo at={row.observed_at} /> : "—"}
            </span>
          </div>
        </Panel>
      ))}
    </div>
  );
}
