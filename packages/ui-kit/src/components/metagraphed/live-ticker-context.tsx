import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * #8365. A single shared 1s clock for every {@link TimeAgo} mounted under a
 * {@link LiveTickerProvider}, replacing N independent per-row `setTimeout`
 * schedules with one `setInterval`. Purely additive: `TimeAgo` falls back to
 * its own private, already-adaptive per-instance timer (unchanged) whenever
 * no provider is an ancestor, so every existing page that doesn't opt in is
 * completely unaffected -- this is a targeted optimization for a genuinely
 * busy live surface (a table with many sub-minute-old rows updating
 * together), not a wholesale replacement for `TimeAgo`'s default behavior.
 *
 * The context value is a plain incrementing counter, not a timestamp: only
 * its IDENTITY changing (any change) matters to trigger a re-render in
 * every subscriber via `useContext`'s own subscription -- consumers read
 * the real current time themselves when they re-render, they don't consume
 * the counter's value.
 */
const LiveTickerContext = createContext<number | null>(null);

export function LiveTickerProvider({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <LiveTickerContext.Provider value={tick}>
      {children}
    </LiveTickerContext.Provider>
  );
}

/**
 * The nearest {@link LiveTickerProvider}'s tick count, or `null` when none is
 * an ancestor. `TimeAgo` is the only intended direct consumer; exported for
 * any future component that wants to piggyback on the same shared clock
 * rather than schedule its own.
 */
export function useLiveTicker(): number | null {
  return useContext(LiveTickerContext);
}
