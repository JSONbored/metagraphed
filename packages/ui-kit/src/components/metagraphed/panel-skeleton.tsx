import { classNames } from "@/lib/format";

export type PanelSkeletonHeight = "xs" | "sm" | "md" | "lg" | "xl";

const HEIGHT: Record<PanelSkeletonHeight, string> = {
  xs: "h-16",
  sm: "h-24",
  md: "h-32",
  lg: "h-48",
  xl: "h-64",
};

export interface PanelSkeletonProps {
  /** Named height token — matches the ~20 ad-hoc h-XX skeleton fallbacks that
   * were sprinkled across list/detail routes so every panel loads to the same
   * silhouette. */
  height?: PanelSkeletonHeight;
  /** Screen-reader label. */
  label?: string;
  className?: string;
}

/**
 * Standardized panel loading skeleton. Replaces bare
 * `<Skeleton className="h-64 w-full" />` fallbacks in Suspense boundaries so
 * loading rhythm matches EmptyState / ErrorState / stale rendering.
 */
export function PanelSkeleton({
  height = "md",
  label = "Loading panel…",
  className,
}: PanelSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={classNames(
        "w-full rounded border border-border bg-card overflow-hidden",
        "animate-pulse",
        HEIGHT[height],
        className,
      )}
    >
      <span className="sr-only">{label}</span>
    </div>
  );
}
