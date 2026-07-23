import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Panel } from "@/components/metagraphed/primitives";
import { blockQuery } from "@/lib/metagraphed/queries";
import { classNames, formatNumber } from "@/lib/metagraphed/format";
import type { Block } from "@/lib/metagraphed/types";

/**
 * Two mini-cards showing the previous and next block's extrinsic/event
 * counts and the delta vs. the current block, so you can compare adjacent
 * blocks without navigating. Deltas use up/down tokens for scan.
 */
export function NeighborCompare({ current }: { current: Block }) {
  const prev = current.prev_block_number;
  const next = current.next_block_number;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <NeighborCard direction="prev" ref={prev != null ? String(prev) : null} current={current} />
      <NeighborCard direction="next" ref={next != null ? String(next) : null} current={current} />
    </div>
  );
}

function NeighborCard({
  direction,
  ref,
  current,
}: {
  direction: "prev" | "next";
  ref: string | null;
  current: Block;
}) {
  const q = useQuery({ ...blockQuery(ref ?? "0"), enabled: ref != null });
  const b = q.data?.data ?? null;
  const label = direction === "prev" ? "Previous block" : "Next block";
  const Icon = direction === "prev" ? ArrowLeft : ArrowRight;

  if (!ref) {
    return (
      <Panel dense tone="muted">
        <div className="flex items-center justify-between gap-2 text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Icon className="size-3.5" />
            <span className="mg-type-micro">{label}</span>
          </span>
          <span className="font-mono text-[11px]">
            {direction === "prev" ? "genesis" : "chain tip"}
          </span>
        </div>
      </Panel>
    );
  }

  const ext = b?.extrinsic_count ?? null;
  const evt = b?.event_count ?? null;
  const extDelta = ext != null ? ext - (current.extrinsic_count ?? 0) : null;
  const evtDelta = evt != null ? evt - (current.event_count ?? 0) : null;

  return (
    <Panel dense interactive>
      <Link
        to="/blocks/$ref"
        params={{ ref }}
        className="mg-focus-ring block -m-[var(--mg-panel-pad-dense)] p-[var(--mg-panel-pad-dense)]"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="mg-type-micro inline-flex items-center gap-1.5 text-ink-muted">
            {direction === "prev" ? <Icon className="size-3.5" /> : null}
            {label}
            {direction === "next" ? <Icon className="size-3.5" /> : null}
          </span>
          <span className="font-mono text-[12px] font-semibold tabular-nums text-ink-strong">
            #{formatNumber(Number(ref))}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums">
          <DeltaChip label="ext" value={ext} delta={extDelta} loading={q.isPending} />
          <DeltaChip label="evt" value={evt} delta={evtDelta} loading={q.isPending} />
        </div>
      </Link>
    </Panel>
  );
}

function DeltaChip({
  label,
  value,
  delta,
  loading,
}: {
  label: string;
  value: number | null;
  delta: number | null;
  loading: boolean;
}) {
  const tone =
    delta == null || delta === 0
      ? "text-ink-muted"
      : delta > 0
        ? "text-health-ok"
        : "text-health-down";
  return (
    <div className="rounded border border-border/60 bg-paper px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-widest text-ink-subtle">{label}</div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2">
        <span className="text-ink-strong">
          {loading ? "…" : value != null ? formatNumber(value) : "—"}
        </span>
        {delta != null && !loading ? (
          <span className={classNames("text-[10px]", tone)}>
            {delta > 0 ? "+" : ""}
            {formatNumber(delta)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
