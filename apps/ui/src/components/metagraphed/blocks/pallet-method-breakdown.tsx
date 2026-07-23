import { useMemo } from "react";
import { Panel } from "@/components/metagraphed/primitives";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { ChainEvent } from "@/lib/metagraphed/types";

/**
 * Groups a block's raw pallet events by `pallet.method` and renders a ranked
 * bar list. Surfaces which subsystems dominated the block (staking, balances,
 * subtensor emissions, sudo, system) without forcing the user to read the raw
 * chain-events table below.
 */
export function PalletMethodBreakdown({ events }: { events: ChainEvent[] }) {
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      if (!e.pallet && !e.method) continue;
      const key = `${e.pallet ?? "?"}.${e.method ?? "?"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }, [events]);

  if (rows.length === 0) return null;
  const max = rows[0]?.count ?? 1;
  const total = events.length;

  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          Pallet · method breakdown
          <InfoTooltip label="Top 10 pallet.method combinations from the block's raw event stream. Longer bars mean that runtime call dominated the block." />
        </span>
      }
      caption={`${formatNumber(rows.length)} of ${formatNumber(uniqueMethods(events))} distinct methods · ${formatNumber(total)} events total`}
    >
      <ol className="divide-y divide-border/60">
        {rows.map((r, i) => {
          const pct = Math.max(3, Math.round((r.count / max) * 100));
          const share = total > 0 ? (r.count / total) * 100 : 0;
          const [pallet, method] = r.label.split(".");
          return (
            <li
              key={r.label}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5 min-w-0">
                  <span className="mg-type-micro shrink-0 text-ink-subtle tabular-nums">
                    #{i + 1}
                  </span>
                  <span className="font-mono text-[12px] text-ink-strong truncate" title={r.label}>
                    <span className="text-ink-muted">{pallet}.</span>
                    {method}
                  </span>
                </div>
                <div
                  aria-hidden
                  className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-border/60"
                >
                  <div
                    className={classNames(
                      "h-full rounded-full",
                      i === 0 ? "bg-accent" : "bg-ink-strong/40",
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
              <div className="shrink-0 text-right font-mono text-[11px] tabular-nums">
                <div className="text-ink-strong">{formatNumber(r.count)}</div>
                <div className="text-[10px] text-ink-muted">{share.toFixed(1)}%</div>
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function uniqueMethods(events: ChainEvent[]): number {
  const s = new Set<string>();
  for (const e of events) s.add(`${e.pallet ?? "?"}.${e.method ?? "?"}`);
  return s.size;
}
