import type { ReactNode, ElementType, ComponentPropsWithoutRef } from "react";
import { classNames } from "@/lib/format";
import { SectionLabel } from "./section-label";

export type PanelTone = "default" | "accent" | "warn" | "down" | "ok" | "muted";

interface ToneStyle {
  border: string;
  bg: string;
}

const TONE_STYLES: Record<PanelTone, ToneStyle> = {
  default: { border: "border-border", bg: "bg-card" },
  accent: { border: "border-accent/40", bg: "bg-primary-soft" },
  warn: { border: "border-health-warn/40", bg: "bg-health-warn/5" },
  down: { border: "border-health-down/40", bg: "bg-health-down/5" },
  ok: { border: "border-health-ok/40", bg: "bg-health-ok/5" },
  muted: { border: "border-border", bg: "bg-surface-2" },
};

interface PanelOwnProps {
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
  /** Keep the tone's border but skip its tinted background (bg-card instead).
   * Covers shells that deliberately want an ok/warn/down/accent border
   * without the matching tinted fill (#7848). */
  tintBorderOnly?: boolean;
  /** Appends the existing --mg-card-glow(-accent) soft-elevation shadow
   * class (#6398) — picks the accent variant automatically when
   * tone="accent". Does not reimplement the CSS; that class stays
   * canonical in styles.css. */
  glow?: boolean;
  as?: ElementType;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}

export type PanelProps = PanelOwnProps &
  Omit<ComponentPropsWithoutRef<"section">, keyof PanelOwnProps>;

/**
 * Batch B primitive. Replaces the ~500 ad-hoc
 * `rounded border border-border bg-card p-4` shells scattered across
 * routes and panels. Reads --mg-panel-pad tokens so density stays
 * consistent site-wide and contributors stop reinventing card headers.
 *
 * Forwards any other HTML/ARIA attribute (id, aria-label, aria-live,
 * role, data-*, …) to the outer element, so a shell that needs one no
 * longer has to hand-roll `rounded border bg-card` instead of using
 * this primitive (#7848).
 */
export function Panel({
  title,
  action,
  caption,
  dense,
  flush,
  interactive,
  tone = "default",
  tintBorderOnly,
  glow,
  as,
  className,
  bodyClassName,
  children,
  ...rest
}: PanelProps) {
  const Cmp: ElementType = as ?? "section";
  const hasHeader = title != null || action != null || caption != null;
  const padClass = flush
    ? "mg-panel-pad-flush"
    : dense
      ? "mg-panel-pad-dense"
      : "mg-panel-pad";
  const toneStyle = TONE_STYLES[tone];
  return (
    <Cmp
      {...rest}
      className={classNames(
        "rounded border",
        toneStyle.border,
        tintBorderOnly ? "bg-card" : toneStyle.bg,
        interactive ? "mg-hover-lift" : null,
        glow
          ? tone === "accent"
            ? "mg-card-glow-accent"
            : "mg-card-glow"
          : null,
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
              <p className="mt-1 mg-type-caption-lg text-ink-muted">
                {caption}
              </p>
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
