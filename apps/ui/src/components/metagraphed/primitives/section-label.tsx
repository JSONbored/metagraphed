import type { ReactNode, ElementType } from "react";
import { classNames } from "@/lib/metagraphed/format";

export type SectionLabelTone = "default" | "muted" | "accent" | "warn" | "down";
export type SectionLabelSize = "micro" | "label";

const TONE_CLASSES: Record<SectionLabelTone, string> = {
  default: "text-ink-muted",
  muted: "text-ink-subtle-text",
  accent: "text-accent-text",
  warn: "text-health-warn-text",
  down: "text-health-down",
};

export interface SectionLabelProps {
  children: ReactNode;
  /** Uppercase-mono size — `micro` = 9.5px (panel titles), `label` = 11px (inline). */
  size?: SectionLabelSize;
  tone?: SectionLabelTone;
  /** Optional leading icon (~12px). */
  icon?: ReactNode;
  /** Trailing hint text (e.g. count "12"). */
  hint?: ReactNode;
  as?: ElementType;
  className?: string;
  title?: string;
}

/**
 * Batch B primitive. Replaces the hundreds of hand-rolled
 * `font-mono text-[9.5px] uppercase tracking-widest text-ink-muted`
 * micro-labels across panels, cards, and headers. Enforced via the
 * ESLint guardrail that blocks bare `text-[…px]` sizes outside vendor.
 */
export function SectionLabel({
  children,
  size = "micro",
  tone = "default",
  icon,
  hint,
  as,
  className,
  title,
}: SectionLabelProps) {
  const Cmp: ElementType = as ?? "span";
  return (
    <Cmp
      title={title}
      className={classNames(
        size === "micro" ? "mg-type-micro" : "mg-type-label",
        "inline-flex items-center gap-1.5",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {icon ? (
        <span aria-hidden className="inline-flex size-3 items-center justify-center">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
      {hint != null ? (
        <span className="text-ink-subtle-text normal-case tracking-normal">{hint}</span>
      ) : null}
    </Cmp>
  );
}
