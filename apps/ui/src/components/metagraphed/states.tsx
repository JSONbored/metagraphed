import {
  AlertCircle,
  RefreshCw,
  Inbox,
  Database,
  ExternalLink as ExternalLinkIcon,
  Hourglass,
  WifiOff,
} from "lucide-react";
import { TimeAgo, safeExternalUrl, ExternalLink } from "@jsonbored/ui-kit";
import { ApiError } from "@/lib/metagraphed/client";
import { getNetworkPrefix } from "@/lib/metagraphed/config";
import { isUsableTimestamp } from "@/lib/metagraphed/format";
import { NativeOnlyNotice } from "./native-only-notice";

/** A truthful replacement for a response the API marked as unverified. */
function DataTierUnavailableNotice({
  context,
  onRetry,
}: {
  context?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="status" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Database className="size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-display text-13 font-medium text-ink-strong">
            Data source temporarily unavailable
          </div>
          <p className="text-13 leading-relaxed text-ink-muted">
            {context ? `The ${context} view` : "This view"} cannot verify its current source, so no
            zero or empty result is shown. The rest of the page can continue updating.
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium hover:border-ink/30"
            >
              <RefreshCw className="size-3" /> Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * A block header can reach the live index before its decoded extrinsics or
 * events land in either detail window. The API names that deliberately as
 * `block_detail_unavailable`: it is a temporary coverage gap, not evidence
 * that the block is empty. Treating it as a generic failure makes an explorer
 * look less trustworthy precisely when its honest state is useful.
 */
function BlockDetailUnavailableNotice({
  context,
  onRetry,
}: {
  context?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="status" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <Hourglass className="size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 font-display text-13 font-medium text-ink-strong">
            Decoded block detail is catching up
          </div>
          <p className="text-13 leading-relaxed text-ink-muted">
            This block is indexed, but {context ?? "its decoded detail"} is not yet available in
            either verified detail window. It is not an empty block—retry after the indexer
            reconciles the record.
          </p>
          {onRetry ? (
            <button
              onClick={onRetry}
              className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium hover:border-ink/30"
            >
              <RefreshCw className="size-3" /> Retry
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function BlockDetailCatchupStatus({
  detail,
  attempt,
  total,
}: {
  detail: string;
  attempt: number;
  total: number;
}) {
  const shownAttempt = Math.min(Math.max(1, attempt), total);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Decoded block detail is catching up"
      className="rounded border border-border bg-surface p-3"
    >
      <div className="flex items-start gap-3">
        <Hourglass
          aria-hidden
          className="size-4 shrink-0 text-ink-muted motion-safe:animate-pulse"
        />
        <div className="min-w-0 flex-1">
          <div className="font-display text-13 font-medium text-ink-strong">
            Decoding this new block
          </div>
          <p className="mt-1 text-13 leading-relaxed text-ink-muted">
            The block is live. Its decoded {detail} are catching up and will refresh automatically.
            <span className="ml-1 whitespace-nowrap tabular-nums">
              Attempt {shownAttempt} of {total}.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * #8384: shown instead of a red error card when a request fails because the
 * visitor is genuinely offline (apiFetch's own catch turns a rejected fetch
 * into `ApiError` with `status: 0` -- the same signal router.tsx's retry
 * policy also keys off, so this and "stop burning retries" always agree).
 */
function OfflineNotice({ context }: { context?: string }) {
  return (
    <div role="status" className="rounded border border-border bg-surface p-4 text-center">
      <WifiOff className="mx-auto size-4 text-ink-muted" />
      <p className="mt-2 text-13 leading-relaxed text-ink-muted">
        Couldn't load {context ?? "this data"} — you're offline. It'll refresh automatically once
        you're back online.
      </p>
    </div>
  );
}

/**
 * A 429 is not a fault (#11000).
 *
 * The API meters anonymous callers at 60 requests/minute, and a page render
 * spends several of them, so an ordinary visitor moving fast — and every
 * crawler — will meet this ceiling. Until now it fell through to the red
 * "Couldn't load this data / HTTP 429" card, which says the wrong thing twice:
 * nothing is broken, and the data is not unavailable. It is throttled, it is
 * the caller's own budget, and it works again shortly.
 *
 * Every interactive surface already drew this distinction (search-box.tsx,
 * ask-box.tsx, watch-alert-form.tsx, api-keys-manager.tsx); the read paths were
 * the ones left saying "couldn't load". `role="status"` rather than
 * `role="alert"` for the same reason the copy changed — this is not an error
 * condition to announce as one.
 */
function RateLimitedNotice({ context }: { context?: string }) {
  return (
    <div role="status" className="rounded border border-border bg-surface p-4 text-center">
      <Hourglass className="mx-auto size-4 text-ink-muted" />
      <p className="mt-2 text-13 leading-relaxed text-ink-muted">
        Rate-limited while loading {context ?? "this data"} — you've hit the public API's per-minute
        ceiling. It'll work again in under a minute.
      </p>
    </div>
  );
}

// Re-exported so existing `import { Skeleton, ... } from "@/components/metagraphed/states"`
// call sites keep working -- Skeleton's canonical home is now packages/ui-kit (needed by
// the already-extracted DataTable), this file just isn't the place to update ~40 unrelated
// call sites as a side effect of that.
export { Skeleton } from "@jsonbored/ui-kit";

// Scheme barrier for an EmptyState action link (CodeQL js/xss-through-dom): external
// actions go through safeExternalUrl (http(s) only, no creds/private hosts); internal
// actions must be a relative path / anchor / query — never an inline scheme like
// javascript:. Returns undefined for anything unsafe so the <a> is simply not rendered.
function safeActionHref(action?: { href: string; external?: boolean }): string | undefined {
  if (!action?.href) return undefined;
  if (action.external) return safeExternalUrl(action.href);
  const href = action.href.trim();
  return /^(?:\/(?!\/)|#|\?)/.test(href) ? href : undefined;
}

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
  // #370/#8224: on a non-mainnet partition, two error shapes both mean "not
  // published for this network," not a real fault, and should degrade to an
  // informational notice instead of a red error card:
  //   - `artifact_not_found`: an unbuilt testnet/local artifact (silent gap).
  //   - `not_found` with `meta.network` set: a deliberate mainnet-only route
  //     (workers/api.ts's `isMainnetOnlyApiPath` blocklist, or the `local`
  //     network's no-data 404) — `meta.network` is only ever populated on
  //     these network-partition 404s, never on an ordinary unmatched route.
  if (
    isApi &&
    ((error.code === "artifact_not_found" && getNetworkPrefix() !== "") ||
      (error.code === "not_found" && error.network))
  ) {
    return <NativeOnlyNotice context={context} />;
  }
  // Both explicit 503s and header-marked schema-stable 200 fallbacks use this
  // code. Neither is a measured empty answer, so keep the state informational
  // and explicit rather than rendering a zero or a generic red error card.
  if (isApi && error.code === "data_tier_unavailable") {
    return <DataTierUnavailableNotice context={context} onRetry={onRetry} />;
  }
  // A present block can sit momentarily between the live-follow and decoded
  // history windows. Keep its technical-detail state distinct from both a
  // generic error and a genuinely empty block.
  if (isApi && error.code === "block_detail_unavailable") {
    return <BlockDetailUnavailableNotice context={context} onRetry={onRetry} />;
  }
  // #8384: `status: 0` is apiFetch's own signal for "the fetch itself never
  // reached a server" (network error / genuinely offline) -- see that
  // function's catch block in client.ts.
  if (isApi && error.status === 0) {
    return <OfflineNotice context={context} />;
  }
  // #11000: throttled, not broken. See RateLimitedNotice.
  if (isApi && error.status === 429) {
    return <RateLimitedNotice context={context} />;
  }
  const message = (error as Error)?.message ?? "Unknown error";
  const url = isApi ? error.url : undefined;
  const safeUrl = safeExternalUrl(url); // scheme barrier before using as an href
  const status = isApi ? error.status : undefined;

  return (
    <div
      role="alert"
      className="rounded border border-health-down/30 bg-health-down/5 p-4 text-center"
    >
      <AlertCircle className="mx-auto size-4 text-health-down" />
      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <span className="font-display text-13 font-medium text-ink-strong">
          Couldn't load {context ?? "this data"}
        </span>
        {status ? (
          <code className="rounded bg-surface px-1.5 py-0.5 text-10 text-ink-muted">
            HTTP {status}
          </code>
        ) : null}
      </div>
      <p className="mx-auto mt-1 max-w-md text-13 leading-relaxed text-ink-muted">{message}</p>
      {url ? (
        <code className="mx-auto mt-1 block max-w-md truncate text-10 text-ink-muted">{url}</code>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <button
            onClick={onRetry}
            className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium hover:border-ink/30"
          >
            <RefreshCw className="size-3" /> Retry
          </button>
        ) : null}
        {safeUrl ? (
          <ExternalLink
            bare
            href={safeUrl}
            className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium text-ink-muted hover:border-ink/30 hover:text-ink-strong"
          >
            <ExternalLinkIcon className="size-3" /> Open API URL
          </ExternalLink>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Empty-state component decision rule (#3962).
 *
 * The app has three empty-state primitives; use exactly one per context so a
 * single route never shows two visually different "empty" treatments for no
 * functional reason:
 *
 * - `EmptyState` (this component) — the DEFAULT for general list / card-grid /
 *   section emptiness: a subtle dashed card with an optional last-checked line
 *   and action link. Reach for this whenever a slice is simply empty and there
 *   is no registry-provenance story to tell — including inside a `DataTable`,
 *   which renders whatever you hand its `empty` slot in the table body.
 * - `ErrorState` (this file) — a query that FAILED, with its retry. A
 *   `DataTable` takes one in its `error` slot.
 * - `RegistryEmpty` (`./states/registry-empty`) — registry-PROVENANCE content
 *   specifically: carries a variant badge, a freshness/staleness row, and an
 *   evidence link. Keep it for surfaces/gaps-style panels where provenance is
 *   part of the empty message; it is not a general-purpose empty state.
 */
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
  const actionHref = safeActionHref(action);
  return (
    <div className="rounded border border-dashed border-ink-subtle bg-surface p-6 text-center">
      <Inbox className="mx-auto size-5 text-ink-muted" />
      <div className="mt-2 font-display text-13 font-medium text-ink-strong">{title}</div>
      {description ? (
        <p className="mt-1 text-13 text-ink-muted max-w-md mx-auto">{description}</p>
      ) : null}
      {isUsableTimestamp(lastChecked) ? (
        <div className="mt-2 text-10 text-ink-muted">
          Last checked <TimeAgo at={lastChecked} />
        </div>
      ) : null}
      {action && actionHref ? (
        <a
          href={actionHref}
          {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-13 font-medium hover:border-ink/30"
        >
          {action.label}
          {action.external ? <ExternalLinkIcon className="size-3" /> : null}
        </a>
      ) : null}
    </div>
  );
}

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
        {eyebrow ? <div className="text-10 text-ink-muted mb-1">{eyebrow}</div> : null}
        <h1 className="font-display text-28 font-semibold text-ink-strong">{title}</h1>
        {description ? (
          <p className="mt-1 text-13 text-ink-muted max-w-2xl">{description}</p>
        ) : null}
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  );
}
