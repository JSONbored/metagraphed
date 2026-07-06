import { useEffect, useState } from "react";

/**
 * The effective TanStack Query `refetchInterval`: the numeric interval only
 * while polling is enabled and the tab is visible, otherwise `false` (Query's
 * "don't poll"). Pure, so the tab-hidden / paused gating is unit-testable
 * without mounting a component.
 */
export function resolveRefetchInterval(
  intervalMs: number,
  enabled: boolean,
  visible: boolean,
): number | false {
  return enabled && visible ? intervalMs : false;
}

/** Returns true when the document is visible (or true in SSR). */
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
 * A refetch interval gated on tab visibility and an `enabled` flag: `intervalMs`
 * while the tab is visible and polling is enabled, else `false`. Composes
 * {@link usePageVisible} so callers get the tab-hidden pause for free without
 * having to wire the visibility listener themselves.
 */
export function useRefetchInterval(intervalMs: number, enabled = true): number | false {
  const visible = usePageVisible();
  return resolveRefetchInterval(intervalMs, enabled, visible);
}
