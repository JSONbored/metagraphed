import { useEffect, useState } from "react";
import {
  formatFreshnessAbsolute,
  formatRelative,
  isUsableTimestamp,
} from "@/lib/format";
import { useLiveTicker } from "./live-ticker-context";

/** Absolute local-time tooltip for {@link TimeAgo}, gated like the visible relative text. */
export function timeAgoAbsoluteTitle(at?: string | null): string | undefined {
  if (!isUsableTimestamp(at)) return undefined;
  return formatFreshnessAbsolute(at) ?? undefined;
}

/**
 * How long until a {@link TimeAgo} showing a timestamp of the given age
 * should next re-render (#8444). `formatRelative`'s own granularity only
 * changes once a minute past the first minute, so re-rendering every second
 * everywhere on a data-dense page (a table of dozens of rows, each with its
 * own TimeAgo) would burn cycles for zero visible difference once an entry
 * is more than a minute old. Sub-minute ages are exactly where a reader
 * benefits from watching the count actually climb, so those still tick
 * every second.
 */
export function timeAgoTickDelayMs(ageMs: number): number {
  return ageMs < 60_000 ? 1_000 : 60_000;
}

/**
 * Renders a relative timestamp ("2m ago") that keeps itself current --
 * only after mount (server output is an empty string with
 * suppressHydrationWarning so the client can swap in the live value without
 * a hydration mismatch), then re-renders on its own schedule
 * ({@link timeAgoTickDelayMs}) rather than only whenever its parent happens
 * to re-render for an unrelated reason. Without this, a page whose data
 * only refreshes on a slow poll (or not at all after the initial load)
 * showed every age frozen at whatever it read on mount.
 *
 * #8365: when a {@link LiveTickerProvider} is an ancestor, this subscribes
 * to that ONE shared clock instead of scheduling its own `setTimeout` --
 * `useContext`'s own subscription re-renders this component on every shared
 * tick, so the render body's fresh `formatRelative(at)` call is all that's
 * needed; no per-instance timer to schedule at all. Falls back to the
 * private adaptive timer below when no provider is present, which is the
 * common case and is completely unchanged.
 */
export function TimeAgo({
  at,
  className,
  fallback = "—",
}: {
  at?: string | null;
  className?: string;
  fallback?: string;
}) {
  const [mounted, setMounted] = useState(false);
  const [, forceTick] = useState(0);
  const sharedTicker = useLiveTicker();
  const hasSharedTicker = sharedTicker !== null;
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted || !at || hasSharedTicker) return undefined;
    const ts = new Date(at).getTime();
    if (!Number.isFinite(ts)) return undefined;
    let timeoutId: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timeoutId = setTimeout(
        () => {
          forceTick((n) => n + 1);
          schedule();
        },
        timeAgoTickDelayMs(Date.now() - ts),
      );
    };
    schedule();
    return () => clearTimeout(timeoutId);
  }, [mounted, at, hasSharedTicker]);
  const text = !at ? fallback : mounted ? formatRelative(at) : "";
  return (
    <span
      className={className}
      title={timeAgoAbsoluteTitle(at)}
      suppressHydrationWarning
    >
      {text}
    </span>
  );
}
