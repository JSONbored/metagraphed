import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { Panel } from "@/components/metagraphed/primitives";
import { InfoTooltip } from "@jsonbored/ui-kit";
import { classNames, formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import type { Block } from "@/lib/metagraphed/types";

/**
 * 60-cell heatmap of inter-block gaps for the current page. Rows are
 * newest-first; the ribbon reads left→right oldest→newest so cadence trends
 * scan naturally. Colour tone comes from the shared health tokens — never a
 * one-off palette — so "slow" reads consistent with the rest of the site.
 */
export function CadenceHeatmap({ rows }: { rows: Block[] }) {
  const cells = useMemo(() => {
    // Oldest→newest for scan order.
    const asc = [...rows].sort((a, b) => a.block_number - b.block_number);
    const out: Array<{ block: Block; gapSec: number | null }> = [];
    for (let i = 0; i < asc.length; i++) {
      const cur = asc[i]!;
      const prev = asc[i - 1];
      let gapSec: number | null = null;
      if (prev?.observed_at && cur.observed_at) {
        const g = Date.parse(cur.observed_at) - Date.parse(prev.observed_at);
        if (Number.isFinite(g)) gapSec = g / 1000;
      }
      out.push({ block: cur, gapSec });
    }
    return out;
  }, [rows]);

  if (cells.length === 0) return null;

  const measured = cells.filter((c) => c.gapSec != null);
  const mean = measured.length
    ? measured.reduce((s, c) => s + (c.gapSec ?? 0), 0) / measured.length
    : null;
  const slow = measured.filter((c) => (c.gapSec ?? 0) > 24).length;
  const stalled = measured.filter((c) => (c.gapSec ?? 0) > 48).length;

  return (
    <Panel
      className="mb-8"
      title={
        <span className="inline-flex items-center gap-1.5">
          Cadence heatmap
          <InfoTooltip label="Seconds between consecutive blocks on this page. Subtensor targets ~12s; deeper mint = faster, amber = slow, red = stalled slot." />
        </span>
      }
      action={
        <div className="flex items-center gap-3 mg-type-micro text-ink-muted">
          {mean != null ? <span>mean {humaniseSeconds(mean)}</span> : null}
          <span className={slow ? "text-health-warn-text" : ""}>slow {slow}</span>
          <span className={stalled ? "text-health-down" : ""}>stalled {stalled}</span>
        </div>
      }
    >
      <ol
        className="flex flex-wrap gap-[3px]"
        role="group"
        aria-label="Per-block cadence for the current page"
      >
        {cells.map(({ block, gapSec }) => {
          const tone = toneFor(gapSec);
          return (
            <li key={block.block_number} className="shrink-0">
              <Link
                to="/blocks/$ref"
                params={{ ref: String(block.block_number) }}
                className={classNames(
                  "mg-focus-ring block h-5 w-[10px] rounded-[2px] transition-transform hover:scale-125",
                  tone.cls,
                )}
                title={`#${formatNumber(block.block_number)} · ${
                  gapSec != null ? `+${humaniseSeconds(gapSec)}` : "no prev sample"
                }`}
                aria-label={`Block ${block.block_number}${
                  gapSec != null ? `, ${humaniseSeconds(gapSec)} after previous` : ""
                }`}
              />
            </li>
          );
        })}
      </ol>
      <Legend />
    </Panel>
  );
}

function toneFor(gapSec: number | null): { cls: string } {
  if (gapSec == null) return { cls: "bg-border/60" };
  if (gapSec > 48) return { cls: "bg-health-down/80" };
  if (gapSec > 24) return { cls: "bg-health-warn/70" };
  if (gapSec > 14) return { cls: "bg-accent/40" };
  if (gapSec > 10) return { cls: "bg-accent/70" };
  return { cls: "bg-accent" };
}

function Legend() {
  const items: Array<{ label: string; cls: string }> = [
    { label: "≤10s", cls: "bg-accent" },
    { label: "12s", cls: "bg-accent/70" },
    { label: "14s", cls: "bg-accent/40" },
    { label: ">24s", cls: "bg-health-warn/70" },
    { label: ">48s", cls: "bg-health-down/80" },
  ];
  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/60 pt-2.5 mg-type-micro text-ink-muted">
      <span>faster</span>
      <div className="flex items-center gap-1">
        {items.map((i) => (
          <span key={i.label} className="inline-flex items-center gap-1">
            <span className={classNames("inline-block h-2 w-3 rounded-[2px]", i.cls)} />
            <span>{i.label}</span>
          </span>
        ))}
      </div>
      <span>slower</span>
    </div>
  );
}
