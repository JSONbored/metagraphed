import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Panel, PanelSkeleton } from "@/components/metagraphed/primitives";
import { InfoTooltip, TimeAgo } from "@jsonbored/ui-kit";
import { runtimeVersionHistoryQuery } from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";

/**
 * Compact horizontal timeline of runtime spec-version transitions. Every
 * chip is the earliest block observed at that spec_version; hovering
 * reveals the exact block + time, clicking jumps to the block. Coverage
 * caveat (data only reliable from #4316) surfaces as a caption.
 */
export function RuntimeTimeline() {
  const q = useQuery(runtimeVersionHistoryQuery());
  if (q.isPending) return <PanelSkeleton height="sm" className="mb-6" />;
  const payload = q.data?.data;
  if (!payload || payload.transitions.length === 0) return null;
  const transitions = [...payload.transitions].sort(
    (a, b) => (a.block_number ?? 0) - (b.block_number ?? 0),
  );
  const current = payload.current_spec_version;
  return (
    <Panel
      className="mb-6"
      title={
        <span className="inline-flex items-center gap-1.5">
          Runtime upgrades
          <InfoTooltip label="Every distinct spec_version this endpoint has seen and the earliest block it was observed at. spec_version wasn't tracked before the coverage floor." />
        </span>
      }
      action={
        current != null ? (
          <span
            className="mg-chip h-6 border-accent/40 text-accent-text px-2 mg-type-micro"
            title="Current runtime spec"
          >
            v{current}
          </span>
        ) : null
      }
      caption={
        payload.coverage_from_block != null ? (
          <span className="font-mono text-[11px] text-ink-muted">
            Coverage from #{formatNumber(payload.coverage_from_block)} ·{" "}
            <TimeAgo at={payload.coverage_from_at} />
          </span>
        ) : null
      }
    >
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {transitions.map((t, i) => {
          const isLatest = i === transitions.length - 1;
          const ref = t.block_number != null ? String(t.block_number) : null;
          const inner = (
            <div
              className={
                "flex flex-col gap-0.5 rounded border px-2.5 py-1.5 transition-colors " +
                (isLatest
                  ? "border-accent/60 bg-accent/10"
                  : "border-border bg-paper hover:border-ink/30 hover:bg-surface")
              }
            >
              <span
                className={
                  "font-mono text-[11px] font-semibold tabular-nums " +
                  (isLatest ? "text-accent-text" : "text-ink-strong")
                }
              >
                v{t.spec_version ?? "?"}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-ink-muted">
                #{t.block_number != null ? formatNumber(t.block_number) : "—"}
              </span>
              <span className="font-mono text-[10px] text-ink-subtle">
                <TimeAgo at={t.observed_at} />
              </span>
            </div>
          );
          return (
            <li key={`${t.spec_version}-${t.block_number}`}>
              {ref ? (
                <Link to="/blocks/$ref" params={{ ref }} className="mg-focus-ring block">
                  {inner}
                </Link>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
