import type { LucideIcon } from "lucide-react";
import { classNames } from "@/lib/metagraphed/format";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  Icon?: LucideIcon;
  /** aria-label for this tab; defaults to `label`. */
  ariaLabel?: string;
  /** title for this tab; defaults to `label`. */
  title?: string;
}

interface SegmentedToggleProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** aria-label for the tablist container. */
  ariaLabel: string;
  className?: string;
}

/**
 * #3426: shared segmented (tablist) toggle. Renders the border/rounded wrapper
 * and per-option `role="tab"` buttons with the active/inactive styling that
 * `ViewModeToggle` and `DensityToggle` previously hand-rolled byte-for-byte.
 * Presentational only — the markup is unchanged from those originals, so there
 * is no visual or behavioral diff; it just removes the duplication.
 */
export function SegmentedToggle<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
}: SegmentedToggleProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {options.map(({ value: optionValue, label, Icon, ariaLabel: optionAriaLabel, title }) => {
        const active = optionValue === value;
        return (
          <button
            key={optionValue}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={optionAriaLabel ?? label}
            title={title ?? label}
            onClick={() => onChange(optionValue)}
            className={classNames(
              "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
              active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {Icon ? <Icon className="size-3.5" /> : null}
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
