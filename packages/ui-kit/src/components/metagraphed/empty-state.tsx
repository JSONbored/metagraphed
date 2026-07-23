import type { ComponentType, ReactNode } from "react";
import {
  AlertTriangle,
  ExternalLink,
  Filter,
  Inbox,
  RotateCcw,
} from "lucide-react";
import { classNames } from "@/lib/format";

export type EmptyStateVariant = "empty" | "filtered" | "error" | "stale";

const VARIANT_ICON: Record<
  EmptyStateVariant,
  ComponentType<{ className?: string }>
> = {
  empty: Inbox,
  filtered: Filter,
  error: AlertTriangle,
  stale: RotateCcw,
};

const VARIANT_TONE: Record<EmptyStateVariant, string> = {
  empty: "text-ink-muted",
  filtered: "text-ink-muted",
  error: "text-health-down",
  stale: "text-health-warn-text",
};

export interface EmptyStateProps {
  variant?: EmptyStateVariant;
  title: ReactNode;
  hint?: ReactNode;
  /** Optional call-to-action button/link node. */
  action?: ReactNode;
  /** External evidence/source URL — rendered as a small trailing link. */
  evidenceHref?: string;
  evidenceLabel?: string;
  /** Override the default variant icon. */
  icon?: ComponentType<{ className?: string }>;
  className?: string;
  /** Compact vertical padding (for inline table cells). */
  dense?: boolean;
}

/**
 * Batch B primitive. Every list route ships the same empty / filtered /
 * error / stale shell so contributors stop hand-rolling one per page.
 */
export function EmptyState({
  variant = "empty",
  title,
  hint,
  action,
  evidenceHref,
  evidenceLabel = "Source",
  icon,
  className,
  dense,
}: EmptyStateProps) {
  const Icon = icon ?? VARIANT_ICON[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      aria-live={variant === "error" ? "assertive" : "polite"}
      className={classNames(
        "flex flex-col items-center justify-center text-center gap-3",
        dense ? "py-8" : "py-16",
        className,
      )}
    >
      <span
        aria-hidden
        className={classNames(
          "inline-flex size-10 items-center justify-center rounded-full border border-border bg-surface-2",
          VARIANT_TONE[variant],
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="font-display text-[15px] font-medium text-ink-strong">
          {title}
        </p>
        {hint != null ? (
          <p className="text-[13px] leading-relaxed text-ink-muted">{hint}</p>
        ) : null}
      </div>
      {action != null || evidenceHref ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {evidenceHref ? (
            <a
              href={evidenceHref}
              target="_blank"
              rel="noreferrer"
              className="mg-focus-ring inline-flex items-center gap-1 mg-type-label uppercase text-ink-muted hover:text-ink-strong"
            >
              {evidenceLabel}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
