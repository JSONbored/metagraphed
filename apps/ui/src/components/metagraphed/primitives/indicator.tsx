import type { ComponentType, ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

export interface IndicatorProps {
  /** Lucide icon component (or any 12-16px SVG component). */
  icon?: ComponentType<{ className?: string }>;
  /** Short uppercase key label rendered above/beside the value. */
  label: string;
  /** Primary value — number or short text. */
  value: ReactNode;
  /** Optional trailing hint, e.g. "of 129". */
  hint?: ReactNode;
  /** Tooltip / aria description of the exact measurement. */
  title?: string;
  className?: string;
  /** Row layout renders label · value inline (grid cards). Column stacks. */
  orientation?: "row" | "column";
}

/**
 * Grid-card indicator: icon + short label + tabular numeric value.
 * Standardizes icon size (12px), gap, tabular-nums, and mono label
 * treatment so the subnets and endpoints grids stay visually aligned.
 */
export function Indicator({
  icon: Icon,
  label,
  value,
  hint,
  title,
  className,
  orientation = "row",
}: IndicatorProps) {
  const isRow = orientation === "row";
  return (
    <span
      title={title}
      className={classNames(
        "inline-flex min-w-0",
        isRow ? "items-baseline gap-1.5" : "flex-col gap-0.5",
        className,
      )}
    >
      <span
        className={classNames(
          "inline-flex items-center gap-1 mg-type-micro text-ink-muted",
          isRow ? "self-center" : null,
        )}
      >
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {label}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-ink-strong truncate">
        {value}
        {hint ? <span className="ml-1 text-ink-muted normal-case">{hint}</span> : null}
      </span>
    </span>
  );
}
