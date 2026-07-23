import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { PanelSkeleton, type PanelSkeletonHeight } from "./panel-skeleton";

export interface RoutePendingProps {
  /** Optional title label rendered as a masthead-height skeleton. */
  title?: string;
  /** Number of panel skeletons to render below the masthead. */
  panels?: number;
  /** Height preset for each panel skeleton. */
  panelHeight?: PanelSkeletonHeight;
  /** Optional custom header (e.g. real breadcrumbs) rendered in place of the masthead skeleton. */
  header?: ReactNode;
  className?: string;
}

/**
 * RoutePending — reusable route-level pending scaffold. Renders the same
 * masthead-height frame + N panel skeletons every route uses when its loader
 * is still resolving, so route transitions never flash a blank screen.
 *
 * Wire via `pendingComponent: () => <RoutePending panels={3} />` on any
 * createFileRoute.
 */
export function RoutePending({
  title,
  panels = 2,
  panelHeight = "md",
  header,
  className,
}: RoutePendingProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={classNames(
        "mg-route-pending mx-auto w-full max-w-shell px-4 py-6 md:px-6",
        className,
      )}
    >
      {header ?? (
        <div className="mb-6 space-y-3">
          <div className="h-3 w-32 animate-pulse rounded bg-surface-2" aria-hidden />
          <div className="flex items-baseline gap-3">
            <div className="h-7 w-64 animate-pulse rounded bg-surface-2" aria-hidden />
            {title ? (
              <span className="sr-only">Loading {title}</span>
            ) : (
              <span className="sr-only">Loading page</span>
            )}
          </div>
          <div className="h-3 w-96 max-w-full animate-pulse rounded bg-surface-2/70" aria-hidden />
        </div>
      )}
      <div className="space-y-4">
        {Array.from({ length: panels }).map((_, i) => (
          <PanelSkeleton key={i} height={panelHeight} />
        ))}
      </div>
    </div>
  );
}
