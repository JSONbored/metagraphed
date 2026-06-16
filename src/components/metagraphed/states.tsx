import {
  AlertCircle,
  RefreshCw,
  Inbox,
  Clock,
  ExternalLink as ExternalLinkIcon,
} from "lucide-react";
import { ApiError } from "@/lib/metagraphed/client";
import { getNetworkPrefix } from "@/lib/metagraphed/config";
import { isUsableTimestamp } from "@/lib/metagraphed/format";
import { TimeAgo } from "@/components/metagraphed/time-ago";
import { NativeOnlyNotice } from "./native-only-notice";

export function ErrorState({
  error,
  onRetry,
  context,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Short label (e.g. "endpoints", "schemas") shown in the heading. */
  context?: string;
}) {
  const isApi = error instanceof ApiError;
  // #370: on a non-mainnet partition, `artifact_not_found` is expected — those
  // networks are native-only, so most artifacts legitimately aren't published.
  // Degrade to an informational notice instead of a red error card.
  if (isApi && error.code === "artifact_not_found" && getNetworkPrefix() !== "") {
    return <NativeOnlyNotice context={context} />;
  }
  const message = (error as Error)?.message ?? "Unknown error";
  const url = isApi ? error.url : undefined;
  const status = isApi ? error.status : undefined;

  return (
    <div role="alert" className="rounded border border-health-down/30 bg-health-down/5 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="size-4 shrink-0 text-health-down" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-display text-sm font-medium text-ink-strong">
              Couldn't load {context ?? "this data"}
            </span>
            {status ? (
              <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
                HTTP {status}
              </code>
            ) : null}
          </div>
          <p className="text-xs text-ink-muted leading-relaxed mb-2">{message}</p>
          {url ? (
            <code className="block truncate font-mono text-[10px] text-ink-muted">{url}</code>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetry ? (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
              >
                <RefreshCw className="size-3" /> Retry
              </button>
            ) : null}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:border-ink/30"
              >
                <ExternalLinkIcon className="size-3" /> Open API URL
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title = "Nothing here yet",
  description,
  lastChecked,
  action,
}: {
  title?: string;
  description?: string;
  /** ISO timestamp of when this slice was last refreshed. */
  lastChecked?: string;
  action?: { label: string; href: string; external?: boolean };
}) {
  return (
    <div className="rounded border border-dashed border-ink-subtle bg-surface/30 p-6 text-center">
      <Inbox className="mx-auto size-5 text-ink-muted" />
      <div className="mt-2 font-display text-sm font-medium text-ink-strong">{title}</div>
      {description ? (
        <p className="mt-1 text-xs text-ink-muted max-w-md mx-auto">{description}</p>
      ) : null}
      {isUsableTimestamp(lastChecked) ? (
        <div className="mt-2 font-mono text-[10px] text-ink-muted">
          Last checked <TimeAgo at={lastChecked} />
        </div>
      ) : null}
      {action ? (
        <a
          href={action.href}
          {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="mt-3 inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium hover:border-ink/30"
        >
          {action.label}
          {action.external ? <ExternalLinkIcon className="size-3" /> : null}
        </a>
      ) : null}
    </div>
  );
}

/**
 * A quiet, muted freshness note shown when a snapshot is genuinely stale
 * (callers gate on isStaleFreshness, which is now a 12h threshold) or when
 * freshness metadata is unusable. Unknown timestamps stay user-visible so the
 * UI does not present potentially unverified snapshots as normal.
 */
export function StaleBanner({ generatedAt }: { generatedAt?: string | null }) {
  const hasTimestamp = isUsableTimestamp(generatedAt);
  return (
    <p className="flex items-center gap-1.5 font-mono text-[10px] text-ink-muted">
      <Clock className="size-3 shrink-0" aria-hidden />
      {hasTimestamp ? (
        <>
          Snapshot from <TimeAgo at={generatedAt} /> — may be lagging behind live.
        </>
      ) : (
        <>Snapshot freshness unknown — verify before relying on this data.</>
      )}
    </p>
  );
}

export function Skeleton({ className = "h-4 w-full" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface ${className}`} />;
}

/**
 * Standardized recovery links used by EmptyState / ErrorState across profile
 * pages. Keep labels identical everywhere so the UI feels consistent.
 */
export const RECOVERY = {
  schemas: { label: "Browse all schemas", href: "/schemas" },
  endpoints: { label: "Browse all endpoints", href: "/endpoints" },
  providers: { label: "Browse all providers", href: "/providers" },
  subnets: { label: "Browse all subnets", href: "/subnets" },
  surfaces: { label: "Browse all surfaces", href: "/surfaces" },
  openapi: { label: "Open API reference", href: "/schemas#openapi" },
  gaps: { label: "Browse registry gaps", href: "/gaps" },
} as const;

export function PageHeading({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
      <div>
        {eyebrow ? <div className="mg-label mb-1">{eyebrow}</div> : null}
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink-strong">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-ink-muted max-w-2xl">{description}</p>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
