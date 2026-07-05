import { useEffect, useState } from "react";

/** Initial revealed state before any timer fires. */
export function resolveInitialDelayedReveal(when: boolean, delayMs: number): boolean {
  if (!when) return false;
  if (delayMs <= 0) return true;
  return false;
}

/** Whether the hook should arm a timeout instead of resolving immediately. */
export function shouldDelayReveal(when: boolean, delayMs: number): boolean {
  return when && delayMs > 0;
}

/**
 * Returns `true` after `delayMs` has elapsed since mount. SSR-safe.
 *
 * Useful for "don't show a skeleton if the data is hot in cache" — wrap the
 * skeleton in `if (revealed) <Skeleton />` so cached responses paint instantly
 * without a 1-frame shimmer flash.
 */
export function useDelayedReveal(delayMs = 120, when = true): boolean {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!shouldDelayReveal(when, delayMs)) {
      setRevealed(resolveInitialDelayedReveal(when, delayMs));
      return;
    }
    const t = window.setTimeout(() => setRevealed(true), delayMs);
    return () => window.clearTimeout(t);
  }, [delayMs, when]);
  return revealed;
}
