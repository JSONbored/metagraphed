import { useEffect, useState } from "react";

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
    if (!when) {
      setRevealed(false);
      return;
    }
    if (delayMs <= 0) {
      setRevealed(true);
      return;
    }
    const t = window.setTimeout(() => setRevealed(true), delayMs);
    return () => window.clearTimeout(t);
  }, [delayMs, when]);
  return revealed;
}
