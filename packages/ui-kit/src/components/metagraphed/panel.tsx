import type { ReactNode, ElementType } from "react";
import { classNames } from "@/lib/format";
import { SectionLabel } from "./section-label";

export type PanelTone = "default" | "accent" | "warn" | "down" | "muted";

const TONE_CLASSES: Record<PanelTone, string> = {
  default: "border-border bg-card",
  accent: "border-accent/40 bg-primary-soft",
  warn: "border-health-warn/40 bg-health-warn/5",
  down: "border-health-down/40 bg-health-down/5",
  muted: "border-border bg-surface-2",
};

export interface PanelProps {
  /** Optional uppercase-mono title, rendered via <SectionLabel>. */
  title?: ReactNode;
  /** Right-aligned header slot (buttons, toggles, freshness pill). */
  action?: ReactNode;
  /** Secondary caption under the title. */
  caption?: ReactNode;
  /** Dense padding variant (uses --mg-panel-pad-dense). */
  dense?: boolean;
  /** Zero padding — use when children own their spacing (e.g. tables). */
  flush?: boolean;
  /** Adds the standard hairline hover-lift interaction. */
  interactive?: boolean;
  tone?: PanelTone;
  as?: ElementType;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

/**
 * Batch B primitive. Replaces the ~500 ad-hoc
 * `rounded border border-border bg-card p-4` shells scattered across
 * routes and panels. Reads --mg-panel-pad tokens so density stays
 * consistent site-wide and contributors stop reinventing card headers.
 */
export function Panel({
  title,
  action,
  caption,
  dense,
  flush,
  interactive,
  tone = "default",
  as,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  const Cmp: ElementType = as ?? "section";
  const hasHeader = title != null || action != null || caption != null;
  const padClass = flush
    ? "mg-panel-pad-flush"
    : dense
      ? "mg-panel-pad-dense"
      : "mg-panel-pad";
  return (
    <Cmp
      className={classNames(
        "rounded border",
        TONE_CLASSES[tone],
        interactive ? "mg-hover-lift" : null,
        className,
      )}
    >
      {hasHeader ? (
        <header
          className={classNames(
            "flex items-start justify-between gap-3 border-b border-border/70",
            dense ? "mg-panel-pad-dense" : "mg-panel-pad",
          )}
          style={{
            paddingTop: "var(--mg-space-sm)",
            paddingBottom: "var(--mg-space-sm)",
          }}
        >
          <div className="min-w-0">
            {title != null ? <SectionLabel>{title}</SectionLabel> : null}
            {caption != null ? (
              <p className="mt-1 text-[13px] text-ink-muted">{caption}</p>
            ) : null}
          </div>
          {action != null ? (
            <div className="shrink-0 flex items-center gap-2">{action}</div>
          ) : null}
        </header>
      ) : null}
      <div className={classNames(padClass, bodyClassName)}>{children}</div>
    </Cmp>
  );
}
