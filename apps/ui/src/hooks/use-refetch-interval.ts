import { useEffect, useState } from "react";

/** Compute TanStack Query's refetchInterval from enable + tab-visibility gates. */
export function computeRefetchInterval(
  enabled: boolean,
  visible: boolean,
  intervalMs: number,
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

/** Page-visibility-gated refetch interval for useSuspenseQuery / useQuery polling. */
export function useRefetchInterval(intervalMs: number, enabled = true): number | false {
  const visible = usePageVisible();
  return computeRefetchInterval(enabled, visible, intervalMs);
}
