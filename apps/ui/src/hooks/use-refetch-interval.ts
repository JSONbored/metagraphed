import { useEffect, useState } from "react";

/**
 * TanStack Query `refetchInterval` value: `false` pauses polling when the tab
 * is hidden or the user has paused refresh.
 */
export function resolveRefetchInterval(
  enabled: boolean,
  visible: boolean,
  intervalMs: number,
): number | false {
  if (!enabled || !visible || intervalMs <= 0) return false;
  return intervalMs;
}

/** Returns true when the document is visible (or true during SSR). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/**
 * Visibility- and enable-gated poll interval for live freshness queries.
 * Returns a ms value suitable for TanStack Query's `refetchInterval`, or
 * `false` when polling should pause.
 */
export function useRefetchInterval(intervalMs: number, enabled = true): number | false {
  const visible = usePageVisible();
  return resolveRefetchInterval(enabled, visible, intervalMs);
}
