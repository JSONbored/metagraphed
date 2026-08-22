import { useMemo } from "react";
import { LineWithWindow, type LinePoint } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { formatNumber, humaniseSeconds } from "@/lib/metagraphed/format";
import type { Block } from "@/lib/metagraphed/types";

const formatGap = (ms: number) => humaniseSeconds(ms / 1000);
const formatBlock = (t: number) => `#${formatNumber(t)}`;

/**
 * Gap to the previous block, per block, for the current page — the cadence
 * trend. Points are keyed by block number (oldest → newest), so a slow patch
 * reads as a bump and a stall as a spike.
 */
export function CadenceTrend({ rows }: { rows: Block[] }) {
  const points = useMemo<LinePoint[]>(() => {
    const asc = [...rows].sort((a, b) => a.block_number - b.block_number);
    const out: LinePoint[] = [];
    for (let i = 1; i < asc.length; i++) {
      const prev = asc[i - 1]!;
      const cur = asc[i]!;
      if (!prev.observed_at || !cur.observed_at) continue;
      const gap = Date.parse(cur.observed_at) - Date.parse(prev.observed_at);
      if (!Number.isFinite(gap)) continue;
      out.push({ t: cur.block_number, v: Math.max(0, gap) });
    }
    return out;
  }, [rows]);

  if (points.length < 2) return null;

  const mean = points.reduce((s, p) => s + p.v, 0) / points.length;
  const slow = points.filter((p) => p.v > 24_000).length;
  const stalled = points.filter((p) => p.v > 48_000).length;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  return (
    <Panel
      className="mb-8"
      title="Block cadence"
      caption={`Gap to the previous block across this page · mean ${formatGap(mean)} · slow ${slow} · stalled ${stalled}`}
    >
      <LineWithWindow
        compact
        points={points}
        window={{ from: first.t, to: last.t }}
        unit="block gap"
        formatValue={formatGap}
        formatDate={formatBlock}
        formatRange={(from, to) => `${formatBlock(from)} → ${formatBlock(to)}`}
        ariaLabel="Block gap per block for the current page"
        source="cadence"
      />
    </Panel>
  );
}
