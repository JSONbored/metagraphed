import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type DefinitionItem = {
  term: ReactNode;
  detail: ReactNode;
  /** Optional tooltip attached to the term. */
  title?: string;
};

export type DefinitionListProps = {
  items: readonly DefinitionItem[];
  /** `stacked` = term above detail (mobile-friendly).
   *  `inline`  = term / detail on the same row, right-aligned detail.
   *  `grid`    = 2-col responsive grid.
   */
  layout?: "stacked" | "inline" | "grid";
  className?: string;
};

/**
 * Standardized <dl> for metadata blocks (profile fields, endpoint details,
 * provider records). Replaces the many hand-rolled term/detail rows that
 * had drifted in spacing, label size, and tone.
 */
export function DefinitionList({
  items,
  layout = "inline",
  className,
}: DefinitionListProps) {
  if (layout === "grid") {
    return (
      <dl
        className={cn(
          "grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2",
          className,
        )}
      >
        {items.map((it, i) => (
          <div key={i} className="min-w-0">
            <dt title={it.title} className="mg-type-micro text-ink-muted">
              {it.term}
            </dt>
            <dd className="mt-1 truncate text-sm text-ink-strong">
              {it.detail}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (layout === "stacked") {
    return (
      <dl className={cn("space-y-3", className)}>
        {items.map((it, i) => (
          <div key={i} className="min-w-0">
            <dt title={it.title} className="mg-type-micro text-ink-muted">
              {it.term}
            </dt>
            <dd className="mt-1 text-sm text-ink-strong">{it.detail}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className={cn("divide-y divide-border/70", className)}>
      {items.map((it, i) => (
        <div
          key={i}
          className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0"
        >
          <dt
            title={it.title}
            className="mg-type-label shrink-0 text-ink-muted"
          >
            {it.term}
          </dt>
          <dd className="min-w-0 truncate text-right text-sm text-ink-strong">
            {it.detail}
          </dd>
        </div>
      ))}
    </dl>
  );
}
