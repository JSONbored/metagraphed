import { classNames } from "@/lib/format";
import { rovingTabIndex, useRovingTablist } from "@/hooks/use-roving-tablist";
import type { ReactNode } from "react";

export interface TabStripItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Optional right-aligned adornment (count chip, indicator). */
  meta?: ReactNode;
  disabled?: boolean;
}

export interface TabStripProps<T extends string = string> {
  items: readonly TabStripItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Accessible label for the tablist. */
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * Batch C primitive — WAI-ARIA tablist with the Bone & Ink hairline
 * treatment used across explorer/profile/endpoints. Extracts the
 * `role="tablist"` + roving-tabindex + bottom-hairline pattern that had
 * drifted across 6+ call-sites so contributors stop hand-rolling it.
 */
export function TabStrip<T extends string = string>({
  items,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: TabStripProps<T>) {
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.id === value),
  );
  const { tabRef, onKeyDown } = useRovingTablist(items.length, (i) => {
    const it = items[i];
    if (it && !it.disabled) onChange(it.id);
  });
  const pad = size === "sm" ? "px-2 py-1.5" : "px-3 py-2";
  const text = size === "sm" ? "text-[12px]" : "text-[13px]";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={classNames(
        "flex items-center gap-1 border-b border-border",
        className,
      )}
    >
      {items.map((it, i) => {
        const selected = it.id === value;
        return (
          <button
            key={it.id}
            ref={tabRef(i)}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={rovingTabIndex(i, activeIndex)}
            disabled={it.disabled}
            onKeyDown={onKeyDown(i)}
            onClick={() => !it.disabled && onChange(it.id)}
            className={classNames(
              "-mb-px inline-flex items-center gap-2 border-b-2 font-medium transition-colors",
              pad,
              text,
              selected
                ? "border-accent text-ink-strong"
                : "border-transparent text-ink-muted hover:text-ink-strong",
              it.disabled ? "opacity-50 cursor-not-allowed" : null,
            )}
          >
            <span>{it.label}</span>
            {it.meta != null ? (
              <span className="text-ink-muted">{it.meta}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
