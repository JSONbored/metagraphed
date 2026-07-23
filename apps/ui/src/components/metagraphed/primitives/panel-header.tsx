import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SectionLabel } from "./section-label";

export type PanelHeaderProps = {
  title: ReactNode;
  /** Optional short secondary text under the title. */
  description?: ReactNode;
  /** Right-aligned actions slot (buttons, filters, freshness pill). */
  actions?: ReactNode;
  /** Show as a small mg-label micro-label instead of a display heading. */
  variant?: "display" | "micro";
  className?: string;
};

/**
 * Standardized panel header. Replaces the recurring
 * `<div className="flex items-center justify-between">…title + actions…</div>`
 * pattern found on nearly every panel.
 */
export function PanelHeader({
  title,
  description,
  actions,
  variant = "display",
  className,
}: PanelHeaderProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {variant === "micro" ? (
          <SectionLabel>{title}</SectionLabel>
        ) : (
          <h2 className="font-display text-base font-medium leading-tight text-ink-strong">
            {title}
          </h2>
        )}
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
