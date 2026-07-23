import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Panel } from "@/components/metagraphed/primitives";
import { AccountAddress } from "@/components/metagraphed/account-address";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { Block } from "@/lib/metagraphed/types";

/**
 * Aggregates block authors across the current page and renders a compact
 * horizontal-bar leaderboard. Rows are clickable → filters the feed to that
 * author. Concentration on a small window is a leading indicator; the
 * masthead's Nakamoto number is the confirmed metric.
 */
export function AuthorSharePanel({ rows }: { rows: Block[] }) {
  const navigate = useNavigate({ from: "/blocks/" });

  const { top, distinct, total } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of rows) {
      const a = b.author;
      if (!a) continue;
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const arr = Array.from(counts.entries())
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count);
    return { top: arr.slice(0, 8), distinct: arr.length, total: rows.length };
  }, [rows]);

  if (top.length === 0) return null;
  const max = top[0]?.count ?? 1;

  return (
    <Panel
      className="mb-6"
      title={
        <span className="inline-flex items-center gap-1.5">
          Top authors this page
          <InfoTooltip label="Validators that produced the most blocks in this page window. Click a row to filter the feed to only their blocks." />
        </span>
      }
      caption={`${distinct} distinct authors across ${formatNumber(total)} blocks`}
    >
      <ol className="divide-y divide-border/60">
        {top.map(({ author, count }) => {
          const share = total > 0 ? (count / total) * 100 : 0;
          const pct = Math.max(3, Math.round((count / max) * 100));
          const heavy = share >= 20;
          return (
            <li key={author}>
              <button
                type="button"
                onClick={() =>
                  navigate({
                    search: (prev: Record<string, unknown>) =>
                      ({ ...prev, author, offset: 0 }) as never,
                    resetScroll: false,
                  })
                }
                className="mg-focus-ring group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2 text-left transition-colors hover:bg-surface/40 -mx-2 px-2 rounded"
                title="Filter by this author"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <AccountAddress
                      ss58={author}
                      compact
                      keep={6}
                      fallback={<span className="text-ink-muted">—</span>}
                    />
                  </div>
                  <div
                    aria-hidden
                    className="mt-1.5 h-[3px] w-full overflow-hidden rounded-full bg-border/60"
                  >
                    <div
                      className={classNames(
                        "h-full rounded-full transition-[width]",
                        heavy ? "bg-health-warn/80" : "bg-accent/70",
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <div className="shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-strong">
                  <div>{formatNumber(count)}</div>
                  <div
                    className={classNames(
                      "text-[10px]",
                      heavy ? "text-health-warn-text" : "text-ink-muted",
                    )}
                  >
                    {share.toFixed(1)}%
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
