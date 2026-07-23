import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/format";

/**
 * Consistent tooltip legend for every sparkline / mini-stack / density bar
 * across the registry. Four-line shape: metric, source, window, staleness.
 * Wrap any inline viz with this so users always know what they're looking at.
 */
export function SparkLegend({
  children,
  metric,
  source,
  windowLabel,
  updatedAt,
  staleness,
  side = "top",
}: {
  children: ReactNode;
  /** Short metric name, e.g. "Health trend". */
  metric: string;
  /** Clause describing the upstream artifact / measurement. */
  source: string;
  /** Time window label such as "7d" or "latest snapshot". */
  windowLabel?: string | null;
  /** ISO timestamp for the underlying snapshot. */
  updatedAt?: string | null;
  /** One-line fallback / staleness behavior. */
  staleness?: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return (
    // Self-wrapped so SparkLegend works outside AppShell's global provider.
    <TooltipProvider>
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className="inline-flex max-w-full items-center focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
          >
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          sideOffset={6}
          collisionPadding={8}
          avoidCollisions
          className="max-w-xs text-[11px] leading-relaxed"
        >
          <div className="mg-type-micro mb-1">
            {metric}
            {windowLabel ? ` · ${windowLabel}` : ""}
          </div>
          <div className="mb-1">
            <span className="mg-type-micro opacity-70">source · </span>
            {source}
          </div>
          {staleness ? (
            <div className="mb-1">
              <span className="mg-type-micro opacity-70">staleness · </span>
              {staleness}
            </div>
          ) : null}
          {fresh || freshAbs ? (
            <div className="mt-1 font-mono text-[10px] opacity-80">
              {fresh ?? ""}
              {freshAbs ? `${fresh ? " · " : ""}last checked ${freshAbs}` : ""}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
