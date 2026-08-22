import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type GhostButtonSize = "sm" | "md" | "lg";
export type GhostButtonTone = "default" | "accent" | "warn" | "down";

export type GhostButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: GhostButtonSize;
  tone?: GhostButtonTone;
  icon?: ReactNode;
  iconRight?: ReactNode;
};

const SIZE: Record<GhostButtonSize, string> = {
  sm: "min-h-8 px-2.5 text-13",
  md: "min-h-10 px-4 text-13",
  lg: "min-h-11 px-4 text-13",
};

const TONE: Record<GhostButtonTone, string> = {
  default:
    "border-border text-ink-muted hover:border-accent/60 hover:text-ink-strong",
  accent:
    "border-accent/60 bg-primary-soft text-ink-strong hover:border-accent",
  warn: "border-health-warn/60 text-health-warn-text hover:border-health-warn",
  down: "border-health-down/60 text-health-down hover:border-health-down",
};

/**
 * Standard hairline/ghost button used across toolbars and card actions.
 * Replaces the recurring
 * `inline-flex items-center gap-… rounded border border-border bg-card …`
 * clusters so tone, spacing and focus ring stay uniform site-wide.
 */
export const GhostButton = forwardRef<HTMLButtonElement, GhostButtonProps>(
  function GhostButton(
    {
      size = "sm",
      tone = "default",
      icon,
      iconRight,
      className,
      children,
      type,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded border bg-card transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          SIZE[size],
          TONE[tone],
          className,
        )}
        {...rest}
      >
        {icon}
        {children != null ? (
          <span className="min-w-0 truncate">{children}</span>
        ) : null}
        {iconRight}
      </button>
    );
  },
);
