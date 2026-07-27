import { classNames } from "@/lib/metagraphed/format";
import type { SseStatus } from "@/hooks/use-registry-events";

/**
 * Live/Connecting/Polling affordance for any surface subscribed to the chain
 * firehose (`useChainStream`). Extracted from `chain-events-feed.tsx` (#8445)
 * so every streamed surface — Chain hub, Events feed, subnet detail — shares
 * one visual language for "connected to the live firehose" instead of each
 * consumer growing its own copy.
 */
export function StreamStatusChip({
  status,
  testId,
}: {
  status: SseStatus;
  /** `data-testid` for the rendered chip; omit when the caller doesn't need one. */
  testId?: string;
}) {
  const label =
    status === "open"
      ? "Live"
      : status === "connecting"
        ? "Connecting"
        : status === "error"
          ? "Polling"
          : null;
  if (!label) return null;
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1.5 rounded border px-2 py-1 mg-type-caption",
        status === "open"
          ? "border-accent/40 bg-accent/10 text-accent-text"
          : "border-border bg-surface text-ink-muted",
      )}
      title={
        status === "open"
          ? "Connected to /api/v1/chain/stream — new matching events refresh this feed"
          : status === "error"
            ? "Chain stream unavailable — refresh manually or wait for reconnect"
            : "Opening /api/v1/chain/stream"
      }
      data-testid={testId}
      data-stream-status={status}
    >
      {status === "open" ? <span className="mg-live-dot" aria-hidden /> : null}
      {label}
    </span>
  );
}
