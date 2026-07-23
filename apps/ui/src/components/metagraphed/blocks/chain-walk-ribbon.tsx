import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { InfoTooltip, Kbd, Sparkline } from "@jsonbored/ui-kit";
import { BLOCK_TERM_HINTS } from "@/lib/metagraphed/section-hints";
import { blocksQuery } from "@/lib/metagraphed/queries";
import { formatNumber, humaniseSeconds, classNames } from "@/lib/metagraphed/format";
import { ChartSkeleton, Panel } from "@/components/metagraphed/primitives";
import { useIsMobile } from "@/hooks/use-mobile";
import type { Block } from "@/lib/metagraphed/types";

interface Props {
  current: Block;
  /** How many blocks to show on each side of the current block. */
  radius?: number;
}

/**
 * ChainWalkRibbon — dense horizontal walk around the current block.
 * On mobile the ribbon collapses to a single tile (the current block) with
 * prev/next arrows on either side, so the row doesn't squish to 30px tiles.
 */
export function ChainWalkRibbon({ current, radius = 3 }: Props) {
  const isMobile = useIsMobile();
  const effectiveRadius = isMobile ? 0 : radius;
  const from = Math.max(0, current.block_number - effectiveRadius);
  const to = current.block_number + effectiveRadius;
  // Fetch a small window centered on the current block. Cheap: capped at ~2r+1.
  const surroundingQuery = useQuery(
    blocksQuery({
      limit: effectiveRadius * 2 + 4,
      block_start: from,
      block_end: to,
    }),
  );
  const rows = (surroundingQuery.data?.data ?? []) as Block[];
  // Newest-first from the API; sort ascending so the ribbon reads left→right.
  const asc = [...rows].sort((a, b) => a.block_number - b.block_number);

  // Build the tile slots left→right, filling missing neighbors with a placeholder.
  const slots: Array<{ n: number; block: Block | null }> = [];
  for (let n = from; n <= to; n++) {
    slots.push({
      n,
      block: asc.find((b) => b.block_number === n) ?? null,
    });
  }

  // Per-block gap (ms) between consecutive observed blocks — the visible
  // heartbeat of chain cadence. Missing observed_at collapses to null.
  const gaps: number[] = [];
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1]?.observed_at ? Date.parse(asc[i - 1]!.observed_at!) : NaN;
    const cur = asc[i]?.observed_at ? Date.parse(asc[i]!.observed_at!) : NaN;
    if (Number.isFinite(prev) && Number.isFinite(cur)) {
      gaps.push(Math.max(0, cur - prev));
    }
  }
  const gapPoints = gaps.map((v, i) => ({ t: `Δ${i}`, v }));

  const prev = current.prev_block_number;
  const next = current.next_block_number;

  return (
    <Panel as="div" dense>
      <div className="flex items-stretch gap-2">
        {/* Prev arrow */}
        <ArrowBtn
          disabled={prev == null}
          to={prev != null ? String(prev) : undefined}
          direction="prev"
        />
        {/* Ribbon — distributes evenly across the full row */}
        <ol
          className="flex flex-1 items-stretch gap-1.5 min-w-0"
          role="group"
          aria-label="Nearby blocks"
        >
          {slots.map((slot) => {
            const isCurrent = slot.n === current.block_number;
            const hasData = slot.block != null;
            const ext = slot.block?.extrinsic_count ?? 0;
            const density = Math.min(1, ext / 12);
            return (
              <li key={slot.n} className="flex-1 min-w-0">
                {isCurrent ? (
                  <div
                    aria-current="true"
                    className="flex h-full flex-col items-center gap-1 rounded border border-accent/60 bg-accent/10 px-2 py-2"
                  >
                    <span className="mg-type-micro text-accent-text">This</span>
                    <span className="font-mono text-[12px] font-semibold tabular-nums text-ink-strong truncate w-full text-center">
                      #{formatNumber(slot.n)}
                    </span>
                    <DensityBar level={density} accent />
                  </div>
                ) : hasData ? (
                  <Link
                    to="/blocks/$ref"
                    params={{ ref: String(slot.n) }}
                    className={classNames(
                      "flex h-full flex-col items-center gap-1 rounded border px-2 py-2 transition-colors",
                      "border-border bg-paper hover:border-ink/30 hover:bg-surface",
                      "mg-focus-ring",
                    )}
                    title={`Block #${formatNumber(slot.n)}`}
                  >
                    <span className="mg-type-micro text-ink-muted">
                      {slot.n < current.block_number ? "prev" : "next"}
                    </span>
                    <span className="font-mono text-[12px] tabular-nums text-ink-strong truncate w-full text-center">
                      #{formatNumber(slot.n)}
                    </span>
                    <DensityBar level={density} />
                  </Link>
                ) : (
                  <div
                    aria-disabled
                    className="flex h-full flex-col items-center gap-1 rounded border border-dashed border-border/60 px-2 py-2 opacity-40"
                  >
                    <span className="mg-type-micro text-ink-muted">—</span>
                    <span className="font-mono text-[12px] tabular-nums text-ink-muted truncate w-full text-center">
                      #{formatNumber(slot.n)}
                    </span>
                    <DensityBar level={0} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {/* Next arrow */}
        <ArrowBtn
          disabled={next == null}
          to={next != null ? String(next) : undefined}
          direction="next"
        />
      </div>

      {/* Cadence: per-block gap sparkline stretched to full width.
          Hidden on mobile (radius=0) — no neighbors → no cadence trend. */}
      {effectiveRadius > 0 ? (
        <div className="mt-3 flex items-center gap-3 border-t border-border/60 pt-2.5">
          <span className="mg-type-micro text-ink-muted shrink-0 inline-flex items-center gap-1">
            Cadence
            <InfoTooltip label={BLOCK_TERM_HINTS.cadence} />
          </span>
          <div className="flex-1 min-w-0">
            {surroundingQuery.isPending ? (
              <ChartSkeleton height={28} className="w-full" />
            ) : gaps.length > 0 ? (
              <Sparkline
                values={gaps}
                points={gapPoints}
                width={9999}
                height={28}
                ariaLabel="Inter-block gap around this block, older to newer"
                formatValue={(v) => humaniseSeconds(v / 1000)}
              />
            ) : (
              <span className="font-mono text-[11px] text-ink-muted">—</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mg-type-micro text-ink-muted shrink-0">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <span className="hidden sm:inline">to walk</span>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function ArrowBtn({
  disabled,
  to,
  direction,
}: {
  disabled: boolean;
  to?: string;
  direction: "prev" | "next";
}) {
  const label = direction === "prev" ? "Previous block" : "Next block";
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  if (disabled || !to) {
    return (
      <span
        aria-disabled
        title={direction === "prev" ? "No earlier block" : "At chain tip"}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-dashed border-border/60 text-ink-muted opacity-40"
      >
        <Icon className="size-4" aria-hidden />
      </span>
    );
  }
  return (
    <Link
      to="/blocks/$ref"
      params={{ ref: to }}
      aria-label={label}
      title={label}
      className="mg-focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded border border-border bg-paper text-ink-strong transition-colors hover:border-accent/50 hover:bg-accent/5"
    >
      <Icon className="size-4" aria-hidden />
    </Link>
  );
}

function DensityBar({ level, accent }: { level: number; accent?: boolean }) {
  const pct = Math.max(4, Math.round(level * 100));
  return (
    <span
      aria-hidden
      className="block h-[3px] w-full max-w-[52px] overflow-hidden rounded-full bg-border/60"
    >
      <span
        className={classNames(
          "block h-full rounded-full",
          accent ? "bg-accent" : "bg-ink-strong/40",
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
