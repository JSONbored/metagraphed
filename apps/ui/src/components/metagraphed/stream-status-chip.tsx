import { classNames } from "@/lib/metagraphed/format";
import type { SseStatus } from "@/hooks/use-registry-events";

/**
 * Live/Connecting/Polling affordance for any surface subscribed to the chain
 * firehose (`useChainStream`). Extracted from `chain-events-feed.tsx` (#8445)
 * so every streamed surface — Chain hub, Events feed, subnet detail — shares
 * one visual language for "connected to the live firehose" instead of each
 * consumer growing its own copy.
 *
 * #8365: the chip now ALWAYS renders the same DOM shape -- fixed width, dot
 * slot always present -- so a status transition (idle -> connecting -> open,
 * or open -> error on a dropped connection) never shifts whatever sits next
 * to it in the row. It used to return `null` outright for idle/closed and
 * swap between differently-sized label strings ("Live" vs "Connecting" is a
 * 2.5x width difference), each a real layout shift for a sibling sharing a
 * `flex`/`justify-between` row. `invisible` (not a conditional unmount) is
 * what makes this work: the element keeps its box (so siblings never move)
 * while disappearing visually AND from the accessibility tree exactly like
 * the old `return null` did -- `visibility:hidden` is excluded from a11y
 * trees the same way a missing element is, unlike `opacity:0`.
 */
export function StreamStatusChip({
  status,
  testId,
}: {
  status: SseStatus;
  /** `data-testid` for the rendered chip; omit when the caller doesn't need one. */
  testId?: string;
}) {
  const label = status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Polling";
  // idle/closed: nothing meaningful happened yet (or the connection is
  // deliberately paused, e.g. #8365's tab-hidden gating) -- reserve the
  // chip's footprint without showing or announcing anything, same as the
  // prior `return null` communicated, just without the width/existence
  // change that caused.
  const quiet = status === "idle" || status === "closed";
  return (
    <span
      className={classNames(
        "inline-flex min-w-[6.5rem] items-center gap-1.5 rounded border px-2 py-1 mg-type-caption transition-colors",
        status === "open"
          ? "border-accent/40 bg-accent/10 text-accent-text"
          : "border-border bg-surface text-ink-muted",
        quiet && "invisible",
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
      <span className={classNames("mg-live-dot", status !== "open" && "invisible")} aria-hidden />
      {label}
    </span>
  );
}
