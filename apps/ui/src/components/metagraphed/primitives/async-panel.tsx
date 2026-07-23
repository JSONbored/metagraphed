import { Suspense, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QueryErrorBoundary } from "@/components/metagraphed/error-boundary";
import { ErrorState } from "@/components/metagraphed/states";
import { EmptyState, type EmptyStateProps } from "./empty-state";
import { PanelSkeleton, type PanelSkeletonHeight } from "./panel-skeleton";

export interface AsyncPanelProps {
  /** Panel content — usually a component with useSuspenseQuery inside. */
  children: ReactNode;
  /** Skeleton height token used while suspended. */
  height?: PanelSkeletonHeight;
  /** Custom fallback overrides the default PanelSkeleton. */
  fallback?: ReactNode;
  /** Short context label passed through to ErrorState heading. */
  context?: string;
  /**
   * When true, renders the standard EmptyState instead of children. Lets the
   * caller keep the "loaded + empty" branch inside the same shell so every
   * data panel gets identical empty/loading/error rhythm.
   */
  isEmpty?: boolean;
  /**
   * Optional overrides for the empty state. Defaults reuse `context` for a
   * sensible "No {context} yet" title.
   */
  empty?: Partial<EmptyStateProps>;
  /**
   * Query keys to invalidate when the user clicks "Retry" on the error
   * fallback. Falls back to `resetQueries()` when omitted (existing behavior).
   */
  retryQueryKeys?: readonly (readonly unknown[])[];
}

/**
 * Canonical async panel wrapper. Standardizes:
 *   - loading  → PanelSkeleton
 *   - error    → ErrorState with a retry button that re-runs the failed query
 *   - empty    → EmptyState with contextual copy
 * so every data-driven panel gets the same shell without hand-rolling
 * boilerplate at each call site. Reduces per-panel drift from contributor PRs.
 */
export function AsyncPanel({
  children,
  height = "md",
  fallback,
  context,
  isEmpty,
  empty,
  retryQueryKeys,
}: AsyncPanelProps) {
  const queryClient = useQueryClient();

  const handleRetry = (defaultReset: () => void) => {
    if (retryQueryKeys?.length) {
      // Invalidate the specific queries this panel owns — snappier and more
      // targeted than a full resetQueries().
      retryQueryKeys.forEach((key) =>
        queryClient.invalidateQueries({ queryKey: key as unknown[] }),
      );
    }
    defaultReset();
  };

  const content = isEmpty ? (
    <EmptyState
      variant={empty?.variant ?? "empty"}
      title={empty?.title ?? (context ? `No ${context} yet` : "Nothing to show")}
      hint={
        empty?.hint ??
        (context ? `The registry doesn't have any ${context} for this view.` : undefined)
      }
      action={empty?.action}
      evidenceHref={empty?.evidenceHref}
      evidenceLabel={empty?.evidenceLabel}
      icon={empty?.icon}
      className={empty?.className}
      dense={empty?.dense}
    />
  ) : (
    children
  );

  return (
    <QueryErrorBoundary
      fallback={(error, reset) => (
        <ErrorState error={error} onRetry={() => handleRetry(reset)} context={context} />
      )}
    >
      <Suspense fallback={fallback ?? <PanelSkeleton height={height} />}>{content}</Suspense>
    </QueryErrorBoundary>
  );
}
