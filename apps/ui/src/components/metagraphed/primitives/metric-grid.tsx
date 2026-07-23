import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export type MetricGridProps = {
  children: ReactNode;
  /** Column count at each breakpoint. Defaults locked to the 4pt token set. */
  cols?: { base?: 1 | 2; sm?: 2 | 3; md?: 2 | 3 | 4; lg?: 2 | 3 | 4 | 6 };
  /** Gap token — locked to the 4pt scale. */
  gap?: "sm" | "md" | "lg";
  className?: string;
};

const colMap = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  6: "grid-cols-6",
} as const;

const smMap = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" } as const;
const mdMap = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
} as const;
const lgMap = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  6: "lg:grid-cols-6",
} as const;

const gapMap = { sm: "gap-2", md: "gap-3", lg: "gap-4" } as const;

/**
 * Locked metric/card grid. Replaces the ~40 ad-hoc
 * `grid gap-4 sm:grid-cols-2 lg:grid-cols-3` clusters scattered across routes.
 * Use this so gap tokens and breakpoints never drift.
 */
export function MetricGrid({
  children,
  cols = { base: 1, sm: 2, lg: 3 },
  gap = "md",
  className,
}: MetricGridProps) {
  return (
    <div
      className={cn(
        "grid",
        colMap[cols.base ?? 1],
        cols.sm ? smMap[cols.sm] : undefined,
        cols.md ? mdMap[cols.md] : undefined,
        cols.lg ? lgMap[cols.lg] : undefined,
        gapMap[gap],
        className,
      )}
    >
      {children}
    </div>
  );
}
