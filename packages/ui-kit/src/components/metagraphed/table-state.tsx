import { type ReactNode } from "react";
import {
  Inbox,
  AlertCircle,
  RefreshCw,
  Clock,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { classNames } from "@/lib/format";

// Duck-typed rather than `instanceof apps/ui's ApiError` -- that class lives
// in apps/ui (tied to its config/fetch layer), and an `instanceof` check
// against a duplicate class definition here would never match a real
// instance thrown by the app. Shape-checking status/url works identically
// for any error object that carries them, real ApiError included.
function hasApiErrorShape(
  err: unknown,
): err is { status: number; url: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { url?: unknown }).url === "string"
  );
}

type Variant = "empty" | "stale" | "error";

interface Cta {
  label: string;
  href: string;
  external?: boolean;
}

interface Props {
  variant: Variant;
  title: string;
  description?: ReactNode;
  /** ISO timestamp of last refresh (for stale variant or "last checked" line). */
  generatedAt?: string;
  /** Primary CTA — ghost button with mint underline. */
  cta?: Cta;
  /** Secondary CTA (e.g. retry). */
  onRetry?: () => void;
  /** For error variant — pulls status/url from ApiError. */
  error?: unknown;
  className?: string;
}

/**
 * Unified empty / stale / error block for every registry table. Identical
 * padding, copy column, and CTA style so empty states feel consistent across
 * /endpoints, /surfaces, /providers, subnet detail tables.
 */
export function TableState({
  variant,
  title,
  description,
  generatedAt,
  cta,
  onRetry,
  error,
  className,
}: Props) {
  const tone = {
    empty: "border-border",
    stale: "border-health-warn/40",
    error: "border-health-down/40",
  }[variant];

  const Icon = { empty: Inbox, stale: Clock, error: AlertCircle }[variant];
  const iconCls = {
    empty: "text-accent",
    stale: "text-health-warn",
    error: "text-health-down",
  }[variant];

  const apiErr = hasApiErrorShape(error) ? error : null;
  const status = apiErr?.status;
  const url = apiErr?.url;
  const message =
    variant === "error"
      ? ((error as Error | undefined)?.message ?? "Unknown error")
      : undefined;

  return (
    <div
      role={variant === "error" ? "alert" : undefined}
      className={classNames(
        "rounded-xl border bg-card px-8 py-16 text-center",
        tone,
        className,
      )}
    >
      <div className="mx-auto inline-flex size-10 items-center justify-center rounded-full border border-border bg-paper">
        <Icon className={classNames("size-4", iconCls)} />
      </div>
      <h3 className="mt-4 font-display text-base font-semibold text-ink-strong tracking-tight">
        {title}
      </h3>
      {description ? (
        <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted leading-relaxed">
          {description}
        </p>
      ) : null}
      {variant === "stale" && generatedAt ? (
        <p className="mt-3 font-mono text-[11px] text-ink-muted">
          Last verified <TimeAgo at={generatedAt} />
        </p>
      ) : null}
      {message ? (
        <p className="mx-auto mt-3 max-w-md font-mono text-[11px] text-ink-muted">
          {status ? (
            <span className="text-health-down">HTTP {status} · </span>
          ) : null}
          {message}
        </p>
      ) : null}
      {cta || onRetry || url ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-3.5 py-1.5 text-[12px] font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors"
            >
              <RefreshCw className="size-3" /> Retry
            </button>
          ) : null}
          {cta ? (
            <a
              href={cta.href}
              {...(cta.external
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
              className="inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-3.5 py-1.5 text-[12px] font-medium text-paper hover:opacity-90 transition-opacity"
            >
              {cta.label}
              {cta.external ? <ExternalLinkIcon className="size-3" /> : null}
            </a>
          ) : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] font-mono text-ink-muted hover:text-ink-strong"
            >
              View API URL <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
