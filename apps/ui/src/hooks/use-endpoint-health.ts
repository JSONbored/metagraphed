import { useEffect, useState, useSyncExternalStore } from "react";
import { apiLatencySnapshot, subscribeApiLatency } from "@/lib/metagraphed/api-latency";

export type EndpointHealth = "checking" | "ok" | "slow" | "bad" | "down";

export interface EndpointHealthState {
  status: EndpointHealth;
  ms: number | null;
}

// Round-trip latency tiers for the footer's API-endpoint health dot.
const SLOW_MS = 300; // ok → slow (yellow)
const BAD_MS = 800; // slow → bad (orange)
/** How often the hook re-checks whether its sample has aged out. */
const STALE_TICK_MS = 30_000;

/** Pure latency bucketing for the footer health dot; exported for unit tests. */
export function classifyEndpointLatency(ms: number | null): EndpointHealth {
  if (ms == null) return "down";
  if (ms > BAD_MS) return "bad";
  if (ms > SLOW_MS) return "slow";
  return "ok";
}

/**
 * Polls the live API and buckets round-trip latency into health tiers
 * (ok / slow / bad / down) for the footer pulse-strip dot. Re-checks every 30s
 * and whenever the runtime API base or the selected network changes. Read-only
 * — mutates no app state.
 *
 * The probe is network-scoped. This hook predates multi-network addressing and
 * built its URL by hand, so on testnet.metagraph.sh it measured
 * /api/v1/coverage — mainnet's artifact — while every other request on the page
 * went to /api/v1/testnet/*. The dot then reported the latency of a partition
 * the user was not reading, which is worse than no dot: the two artifacts have
 * independent cache states, so a cold testnet read shows green off a warm
 * mainnet one. `/api/v1/coverage` is served on every network, so prefixing it
 * is safe (unlike, say, /api/v1/feeds/watch, which genuinely 404s off mainnet).
 */
/**
 * How long ago a sample stops being evidence.
 *
 * A tab left open on a static page makes no API calls, and a five-minute-old
 * number is not a claim about the API's health NOW. Past this the dot returns
 * to "checking" rather than asserting a stale green -- the same distinction
 * `unknown` vs `stale` draws in the API's own lane verdicts.
 */
const SAMPLE_MAX_AGE_MS = 5 * 60_000;

/**
 * The footer health dot, from the API calls the page ALREADY makes.
 *
 * IT USED TO PROBE. This hook fetched `/api/v1/coverage` itself every 30
 * seconds, on every page, for as long as the tab stayed open -- and measured
 * 2026-08-16, one account page load issued that URL TWICE: once for the data it
 * renders and once more purely to time it. Over a ten-minute session the probe
 * alone was ~20 requests that render nothing.
 *
 * The page was already issuing the measurement. `apiFetch` now records every
 * round trip (see lib/metagraphed/api-latency.ts) and this subscribes, so the
 * dot costs zero requests.
 *
 * IT IS ALSO A BETTER MEASUREMENT. A synthetic probe timed one endpoint nobody
 * was waiting on; this times what the user is actually waiting for, which is
 * what the dot claims to report. A page whose data reads are slow while
 * `/coverage` happened to be warm used to show green. It cannot now.
 *
 * NETWORK SCOPING COMES FOR FREE, and that is worth stating because the old
 * probe had to build its own prefixed URL to get it right (and did not, until
 * it was fixed). Every recorded sample came from `apiFetch`, which resolves the
 * network at call time -- so the samples ARE the selected network's, without
 * this hook knowing that a network exists.
 */
export function useEndpointHealth(): EndpointHealthState {
  const sample = useSyncExternalStore(
    subscribeApiLatency,
    apiLatencySnapshot,
    // SSR and the first client pass must agree, and the server has made no
    // calls -- returning a sample here would hydrate a dot the client then
    // changes, which React reports as a mismatch.
    () => null,
  );
  const [now, setNow] = useState(() => Date.now());

  // The dot has to go stale on its own, with no traffic to push it: a sample
  // ages even when nothing else happens.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), STALE_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  if (!sample) return { status: "checking", ms: null };
  if (now - sample.at > SAMPLE_MAX_AGE_MS) return { status: "checking", ms: null };
  return { status: classifyEndpointLatency(sample.ms), ms: sample.ms };
}
