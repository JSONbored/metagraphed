// The latency of the API calls this page ALREADY makes.
//
// ## Why this exists
//
// `useEndpointHealth` painted the footer's health dot by fetching
// `/api/v1/coverage` itself, every 30 seconds, on every page, for as long as
// the tab stayed open. Measured 2026-08-16 on one account page load: 20 API
// requests, of which `/api/v1/coverage` was TWO -- once for the data the page
// renders, and once more purely to time it. Over a ten-minute session the probe
// alone is ~20 extra requests that render nothing.
//
// The page is already issuing the measurement. Every `apiFetch` is a real
// round trip to the same origin, so recording how long it took answers the
// dot's question -- "is the API up, and how fast" -- for free.
//
// ## Why this is also a BETTER measurement
//
// A synthetic probe times one endpoint that no user is waiting on. This times
// what the user is actually waiting for, which is the number the dot claims to
// report. A page whose data reads are slow while `/coverage` happens to be warm
// used to show green; now it cannot.
//
// ## What it deliberately does not do
//
// No history, no percentiles, no store framework. The dot renders one bucket
// from one number, and anything richer belongs in PostHog -- which already
// receives `$web_vitals` and, since #11442, `Server-Timing` from the API's own
// three storage boundaries. This is the smallest thing that removes a request.

/** One completed API call: how long, and whether it answered at all. */
export interface ApiLatencySample {
  /** Round-trip milliseconds, or null when the request failed outright. */
  ms: number | null;
  /** `Date.now()` at completion, so a stale sample can be told from a fresh one. */
  at: number;
}

let latest: ApiLatencySample | null = null;
const listeners = new Set<() => void>();

/**
 * Record a completed call. Called from `apiFetch`, and from nowhere else --
 * a second writer would be a second definition of "the API's latency".
 *
 * A FAILED REQUEST IS A SAMPLE, not an absence: `ms: null` is what the dot
 * renders as "down", and dropping it would leave the last successful number on
 * screen while nothing works, which is the failure a health dot exists to
 * prevent.
 */
export function recordApiLatency(ms: number | null): void {
  latest = { ms, at: Date.now() };
  for (const listener of listeners) listener();
}

/** The newest sample, or null before the page has made a call. */
export function apiLatencySnapshot(): ApiLatencySample | null {
  return latest;
}

/**
 * Subscribe, in `useSyncExternalStore`'s shape.
 *
 * Returns the unsubscribe, and the store is module-level rather than context
 * because `apiFetch` is called from query functions that have no React tree
 * above them.
 */
export function subscribeApiLatency(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reset, for tests. Module state outlives a test file otherwise. */
export function resetApiLatency(): void {
  latest = null;
  listeners.clear();
}
