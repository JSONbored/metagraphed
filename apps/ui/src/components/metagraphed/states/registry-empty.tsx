import { Link } from "@tanstack/react-router";
import { Inbox, AlertTriangle, Clock, RefreshCw, ArrowRight, Search, FileText } from "lucide-react";
import type { ReactNode } from "react";
import { classNames } from "@/lib/metagraphed/format";
import { formatFreshness, formatFreshnessAbsolute } from "@/lib/metagraphed/freshness";

export type RegistryEmptyVariant = "empty" | "error" | "stale";

interface ActionLink {
  label: string;
  href?: string;
  to?: string;
  onClick?: () => void;
  external?: boolean;
  primary?: boolean;
}

interface Props {
  variant: RegistryEmptyVariant;
  title: string;
  /** Plain-language explainer of why the area is empty/errored/stale. */
  description?: ReactNode;
  /** Up to ~3 next actions. First one with `primary: true` gets the accent treatment. */
  actions?: ActionLink[];
  /** Optional ISO timestamp of the underlying snapshot (used by stale variant). */
  updatedAt?: string | null;
  windowLabel?: string | null;
  /** Optional secondary hint, e.g. how freshness/staleness works. */
  freshnessHint?: ReactNode;
  /** Optional evidence/source link block (URL or component). */
  evidenceHref?: string;
  className?: string;
}

const TONE = {
  empty: {
    Icon: Inbox,
    ring: "border-border bg-card",
    accent: "text-ink-muted",
    badge: "bg-paper text-ink-muted border-border",
    label: "empty",
  },
  error: {
    Icon: AlertTriangle,
    ring: "border-health-down/30 bg-health-down/5",
    accent: "text-health-down",
    badge: "bg-health-down/10 text-health-down border-health-down/30",
    label: "error",
  },
  stale: {
    Icon: Clock,
    ring: "border-health-warn/30 bg-health-warn/5",
    accent: "text-health-warn",
    badge: "bg-health-warn/10 text-health-warn border-health-warn/30",
    label: "stale",
  },
} as const;

/**
 * Unified empty/error/stale state for registry surfaces. Surfaces a clear
 * headline, a plain-language explainer, an optional freshness hint, and a
 * compact row of "next actions" so users always know what to do next.
 *
 * Scope: registry-PROVENANCE content specifically — the badge + freshness +
 * evidence rows are the point. For plain list/grid emptiness use `EmptyState`,
 * and for paginated-table emptiness use `TableState`; see the empty-state
 * decision rule above `EmptyState` in `../states.tsx` (#3962).
 */
export function RegistryEmpty({
  variant,
  title,
  description,
  actions,
  updatedAt,
  windowLabel,
  freshnessHint,
  evidenceHref,
  className,
}: Props) {
  const tone = TONE[variant];
  const Icon = tone.Icon;
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={classNames("rounded-xl border p-4 sm:p-6", tone.ring, className)}
    >
      <div className="flex items-start gap-3">
        <div
          className={classNames(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full border",
            tone.badge,
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink-strong">{title}</h3>
            <span
              className={classNames(
                "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[9.5px] uppercase tracking-widest",
                tone.badge,
              )}
            >
              {tone.label}
            </span>
            {variant === "stale" && fresh ? (
              <span className="font-mono text-[10px] text-ink-muted">
                {fresh}
                {freshAbs ? ` · last checked ${freshAbs}` : ""}
              </span>
            ) : null}
          </div>

          {description ? (
            <p className="text-[13px] leading-relaxed text-ink-muted">{description}</p>
          ) : null}

          {freshnessHint ? (
            <p className="text-[11px] leading-relaxed text-ink-muted/80">
              <span className="font-mono text-[9.5px] uppercase tracking-widest opacity-70">
                how freshness works ·{" "}
              </span>
              {freshnessHint}
            </p>
          ) : null}

          {evidenceHref ? (
            <p className="text-[11px] text-ink-muted">
              <span className="font-mono text-[9.5px] uppercase tracking-widest opacity-70">
                where to verify ·{" "}
              </span>
              <a
                href={evidenceHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                <FileText className="size-3" /> evidence &amp; sources
              </a>
            </p>
          ) : null}

          {actions && actions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {actions.map((a, i) => (
                <ActionButton key={i} action={a} variant={variant} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActionButton({ action, variant }: { action: ActionLink; variant: RegistryEmptyVariant }) {
  const base =
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[10.5px] uppercase tracking-widest transition-colors";
  const primary = action.primary
    ? "border-accent/40 bg-primary-soft text-accent hover:bg-primary-soft/80"
    : "border-border bg-paper text-ink-muted hover:text-ink-strong hover:border-ink/30";
  const Icon = action.primary
    ? variant === "error"
      ? RefreshCw
      : action.external
        ? ArrowRight
        : Search
    : ArrowRight;

  const content = (
    <>
      <Icon className="size-3" />
      <span>{action.label}</span>
    </>
  );

  if (action.to) {
    return (
      <Link to={action.to} className={classNames(base, primary)}>
        {content}
      </Link>
    );
  }
  if (action.href) {
    return (
      <a
        href={action.href}
        target={action.external ? "_blank" : undefined}
        rel={action.external ? "noopener noreferrer" : undefined}
        className={classNames(base, primary)}
      >
        {content}
      </a>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={classNames(base, primary)}>
      {content}
    </button>
  );
}
