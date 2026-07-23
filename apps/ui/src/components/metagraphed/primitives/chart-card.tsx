import type { ReactNode } from "react";
import { Panel } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";
import { FreshnessPill } from "./freshness-pill";

export interface ChartCardProps {
  title: ReactNode;
  caption?: ReactNode;
  /** ISO timestamp — renders a FreshnessPill in the header. */
  updatedAt?: string | null;
  /** Additional header controls (range toggle, filter, etc). */
  action?: ReactNode;
  /** Footer legend / methodology row. */
  footer?: ReactNode;
  /** Fixed chart height so pages don't jump between loading/loaded. */
  height?: number;
  loading?: boolean;
  empty?: boolean;
  emptyLabel?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Batch C primitive — the shared "titled chart with freshness + legend"
 * container. Replaces ad-hoc Panel+header+footer wrappers in the
 * operational, economics, subnet-history, hero-analytics and drift-activity
 * cards so freshness pills, loading skeletons and empty states stay uniform.
 */
export function ChartCard({
  title,
  caption,
  updatedAt,
  action,
  footer,
  height = 200,
  loading,
  empty,
  emptyLabel = "Not enough data yet",
  children,
  className,
}: ChartCardProps) {
  const headerAction = (
    <>
      {updatedAt ? <FreshnessPill updatedAt={updatedAt} /> : null}
      {action}
    </>
  );
  return (
    <Panel title={title} caption={caption} action={headerAction} className={className}>
      <div className="relative w-full" style={{ height }} aria-busy={loading || undefined}>
        {loading ? (
          <div className="absolute inset-0 mg-skel animate-pulse rounded" />
        ) : empty ? (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-ink-muted">
            {emptyLabel}
          </div>
        ) : (
          children
        )}
      </div>
      {footer != null ? (
        <div
          className={classNames(
            "mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3 text-[12px] text-ink-muted",
          )}
        >
          {footer}
        </div>
      ) : null}
    </Panel>
  );
}
