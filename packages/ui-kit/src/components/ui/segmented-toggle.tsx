import { type ComponentType } from "react";
import { classNames } from "@/lib/format";

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  Icon?: ComponentType<{ className?: string }>;
  /** Falls back to `label` when omitted. */
  ariaLabel?: string;
  /** Falls back to `label` when omitted. */
  title?: string;
}

/**
 * Shared `role="tablist"`/`role="tab"`/`aria-selected` segmented switch —
 * the common wrapper/button markup behind ViewModeToggle and DensityToggle.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className,
      )}
    >
      {options.map(
        ({ value: v, label, Icon, ariaLabel: optionAriaLabel, title }) => {
          const active = v === value;
          return (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={optionAriaLabel ?? label}
              title={title ?? label}
              onClick={() => onChange(v)}
              className={classNames(
                "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
                active
                  ? "bg-surface text-ink-strong"
                  : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {Icon ? <Icon className="size-3.5" /> : null}
              <span className="hidden sm:inline">{label}</span>
            </button>
          );
        },
      )}
    </div>
  );
}
