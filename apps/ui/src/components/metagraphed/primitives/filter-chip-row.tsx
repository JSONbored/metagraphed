import { X } from "lucide-react";
import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";

export interface FilterChipItem {
  /** Stable identifier used for the remove callback. */
  id: string;
  /** Short label like "Health". */
  label: string;
  /** The current value, e.g. "healthy" or "2 selected". */
  value: string;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
}

export interface FilterChipRowProps {
  items: FilterChipItem[];
  onRemove: (id: string) => void;
  onClearAll?: () => void;
  className?: string;
}

/**
 * FilterChipRow — renders the currently-active filters as a row of removable
 * hairline chips beneath a QueryBar. Each chip shows `label · value` and has
 * a click-to-remove × affordance. Renders nothing when no filters are active.
 */
export function FilterChipRow({ items, onRemove, onClearAll, className }: FilterChipRowProps) {
  if (items.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Active filters"
      className={classNames("flex flex-wrap items-center gap-1.5 pt-2", className)}
    >
      {items.map((item) => (
        <button
          key={item.id}
          role="listitem"
          type="button"
          onClick={() => onRemove(item.id)}
          aria-label={`Remove ${item.label} filter (${item.value})`}
          className={classNames(
            "group inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2",
            "text-[11px] transition-colors",
            "hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {item.icon ? <span className="text-ink-muted">{item.icon}</span> : null}
          <span className="mg-type-micro text-ink-muted">{item.label}</span>
          <span className="font-medium text-ink-strong">{item.value}</span>
          <X
            aria-hidden
            className="size-3 text-ink-muted transition-colors group-hover:text-health-down"
          />
        </button>
      ))}
      {onClearAll && items.length > 1 ? (
        <button
          type="button"
          onClick={onClearAll}
          className="mg-focus-ring ml-1 rounded px-1.5 py-0.5 mg-type-micro text-ink-muted hover:text-ink-strong"
        >
          Clear all
        </button>
      ) : null}
    </div>
  );
}
