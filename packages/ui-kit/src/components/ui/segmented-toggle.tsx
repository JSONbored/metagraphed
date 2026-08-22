import { type ComponentType } from "react";
import { classNames } from "@/lib/format";
import { Panel } from "@/components/metagraphed/panel";

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
 *
 * Two presentations, and `bare` is the default.
 *
 * `panel` was the original and the only one: a bordered container around
 * pill-shaped buttons whose selected member took a filled background. Five of
 * those in a filter row is five nested boxes competing with the field beside
 * them, and it is the single thing that made these toolbars read as clutter.
 * The reference draws the same control with **no chrome at all** — measured:
 * `background: transparent`, `border: 0`, `border-radius: 0`, `padding: 0`,
 * 13px/500, colour going from faint to full ink on hover and selection. That
 * is `bare`, and it is what a toggle should look like when it sits inside
 * something that already has an edge.
 *
 * `panel` stays for a toggle that floats on the page with nothing around it.
 */
export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  variant = "bare",
}: {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
  variant?: "bare" | "panel";
}) {
  const buttons = options.map(
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
            "mg-focus-ring inline-flex items-center gap-1.5 transition-colors",
            variant === "bare"
              ? classNames(
                  "mg-segmented-bare-option",
                  active ? "text-ink-strong" : "text-ink-muted",
                )
              : classNames(
                  "min-h-8 rounded px-2 py-1 mg-type-caption font-medium",
                  active
                    ? "bg-surface text-ink-strong"
                    : "text-ink-muted hover:text-ink-strong",
                ),
          )}
        >
          {Icon ? <Icon className="size-3.5" /> : null}
          <span className={Icon ? "hidden sm:inline" : undefined}>{label}</span>
        </button>
      );
    },
  );

  if (variant === "bare") {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={classNames("mg-segmented-bare", className)}
      >
        {buttons}
      </div>
    );
  }

  return (
    <Panel
      as="div"
      flush
      role="tablist"
      aria-label={ariaLabel}
      className={className}
      bodyClassName="inline-flex items-center p-0.5"
    >
      {buttons}
    </Panel>
  );
}
