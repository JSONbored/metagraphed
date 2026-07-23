import type { ReactNode } from "react";
import { classNames } from "@/lib/format";

export type ChipTone = "default" | "ok" | "warn" | "down" | "accent" | "muted";

const TONE_CLASSES: Record<ChipTone, string> = {
  default: "border-border bg-paper text-ink",
  ok: "border-health-ok/40 bg-health-ok/10 text-health-ok",
  warn: "border-health-warn/40 bg-health-warn/10 text-health-warn-text",
  down: "border-health-down/40 bg-health-down/10 text-health-down",
  accent: "border-accent/45 bg-primary-soft text-accent-text",
  muted: "border-border bg-surface-2 text-ink-muted",
};

export interface ChipProps {
  tone?: ChipTone;
  /** Optional leading icon; sized to 12px via wrapper. */
  icon?: ReactNode;
  /** If true, renders a small pulsing dot instead of an icon. */
  dot?: boolean;
  /** Uppercase mono micro-label rendered before the value. */
  label?: string;
  children?: ReactNode;
  title?: string;
  className?: string;
  as?: "span" | "button";
  onClick?: () => void;
}

/**
 * Hairline pill used across chips, badges, filter tags. Never uses a shadow
 * or gradient — tone drives border + tinted fill only. Mono cased so it
 * always reads as a data label rather than body text.
 */
export function Chip({
  tone = "default",
  icon,
  dot,
  label,
  children,
  title,
  className,
  as = "span",
  onClick,
}: ChipProps) {
  const Cmp: "span" | "button" = as;
  return (
    <Cmp
      title={title}
      onClick={onClick}
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "font-mono text-[10px] leading-none whitespace-nowrap transition-colors",
        onClick ? "mg-focus-ring hover:border-ink/30 cursor-pointer" : null,
        TONE_CLASSES[tone],
        className,
      )}
    >
      {dot ? (
        <span
          aria-hidden
          className="mg-health-dot"
          style={{ color: "currentColor" }}
        />
      ) : icon ? (
        <span
          aria-hidden
          className="inline-flex size-3 items-center justify-center"
        >
          {icon}
        </span>
      ) : null}
      {label ? (
        <span className="uppercase tracking-widest opacity-70">{label}</span>
      ) : null}
      {children != null ? (
        <span className="text-ink-strong normal-case tracking-normal">
          {children}
        </span>
      ) : null}
    </Cmp>
  );
}
