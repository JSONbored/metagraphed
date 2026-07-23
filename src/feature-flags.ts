// Cloudflare-KV-cached PostHog feature-flag evaluation for the Worker
// backend (metagraphed#7762).
//
// Design decision (required by the issue before implementing): raw HTTP to
// PostHog's own /flags evaluation endpoint on every miss, cached in
// METAGRAPH_CONTROL KV with a short freshness window -- NOT a periodic
// flag-definition sync that re-evaluates rollout/targeting rules locally.
//
// Every other data source in this system syncs on a schedule into KV/R2,
// Workers read-only (ADR 0001) -- that pattern was the first instinct here
// too, and it's the wrong one. PostHog's real evaluation can depend on
// property/cohort targeting and a percentage-rollout hash that isn't a
// small, stable, publicly-documented algorithm safe to reimplement:
// "local evaluation" is a whole SDK feature (posthog.com/docs/feature-flags/
// local-evaluation), not a spec, and posthog-node itself is the thing this
// codebase already excludes on bundle-size grounds (see
// usage-telemetry.ts's own header). Reimplementing a subset of it here
// would risk a caller seeing a DIFFERENT flag state server-side than
// posthog-js resolves for the same person client-side -- a correctness bug
// worse than an extra network hop. Delegating evaluation to PostHog's own
// servers and caching the RESULT keeps this Worker correct by construction.
//
// Same raw-fetch, no-SDK posture as the rest of usage-telemetry.ts, and the
// same POSTHOG_PROJECT_TOKEN secret -- PostHog's /flags endpoint is
// documented as safe to call with the project token (it "does not return
// any sensitive data"), the same write-only-ish trust level as capture.
//
// Cache freshness is short (well under a minute) so a flag flip in
// PostHog's dashboard reaches this Worker fast enough to function as a real
// kill switch -- the whole point of this issue. A fetch or KV failure
// degrades to the last-known cached value when one exists, or the caller's
// own documented default otherwise -- flags must never block a request.

import {
  POSTHOG_PROJECT_TOKEN_ENV,
  isUsageTelemetryConfigured,
  resolvePostHogHost,
} from "./usage-telemetry.js";

/** PostHog's flag-evaluation endpoint, appended to the resolved host. */
export const POSTHOG_FLAGS_PATH = "/flags/?v=2";

// KV entries are kept indefinitely (no expirationTtl) so a stale value
// always exists as the last-known-good fallback -- freshness is judged in
// code below, not by letting the entry disappear.
const CACHE_KEY_PREFIX = "feature-flag:";

// Short enough that toggling a flag in the dashboard reaches production
// within a duration a human calls "fast" while babysitting a rollback --
// long enough that a route taking real traffic doesn't refetch on every
// request. Not user-configurable (yet): revisit with real traffic data if
// this ever needs tuning per-flag.
const CACHE_FRESH_MS = 30_000;

interface CachedFlagState {
  value: boolean;
  fetchedAt: number;
}

export interface EvaluateFeatureFlagDeps {
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => number;
}

function cacheKey(flagKey: string): string {
  return `${CACHE_KEY_PREFIX}${flagKey}`;
}

async function readCache(
  env: Env | null | undefined,
  flagKey: string,
): Promise<CachedFlagState | null> {
  if (!env?.METAGRAPH_CONTROL?.get) return null;
  try {
    const cached = await env.METAGRAPH_CONTROL.get<CachedFlagState>(
      cacheKey(flagKey),
      { type: "json" },
    );
    return cached ?? null;
  } catch {
    // A KV read failure is not a cache miss's fault -- treat it the same
    // way (fall through to a live fetch) rather than letting it propagate.
    return null;
  }
}

async function writeCache(
  env: Env | null | undefined,
  flagKey: string,
  state: CachedFlagState,
): Promise<void> {
  if (!env?.METAGRAPH_CONTROL?.put) return;
  try {
    await env.METAGRAPH_CONTROL.put(cacheKey(flagKey), JSON.stringify(state));
  } catch {
    // A cache-write failure only costs the next request an extra fetch --
    // never let it fail the evaluation that's already in hand.
  }
}

/**
 * Resolve one boolean feature flag for `distinctId`. Never throws --
 * degrades to `defaultValue` (or the last-known-good cached value, if one
 * exists and is more recently known-good than "never fetched") on any
 * failure: unconfigured token, network error, non-2xx response, or a
 * malformed payload. A flag must never be the reason a request fails.
 *
 * `distinctId` matters even for an operational kill-switch flag with no
 * real per-person targeting configured today: PostHog's own evaluation
 * always takes one, and passing a stable, purpose-specific id (e.g.
 * `"metagraphed-worker"`, mirroring usage-telemetry.ts's own
 * USAGE_EVENT_DISTINCT_ID) keeps this call forward-compatible with adding
 * real targeting later without a call-site change.
 */
export async function evaluateFeatureFlag(
  flagKey: string,
  distinctId: string,
  defaultValue: boolean,
  env: Env | null | undefined,
  deps: EvaluateFeatureFlagDeps = {},
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const cached = await readCache(env, flagKey);

  if (cached && now() - cached.fetchedAt < CACHE_FRESH_MS) {
    return cached.value;
  }

  if (!isUsageTelemetryConfigured(env)) {
    return cached ? cached.value : defaultValue;
  }

  try {
    const doFetch = deps.fetch ?? globalThis.fetch;
    const response = await doFetch(
      `${resolvePostHogHost(env)}${POSTHOG_FLAGS_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: String(env?.[POSTHOG_PROJECT_TOKEN_ENV]).trim(),
          distinct_id: distinctId,
        }),
      },
    );
    // No `response?.` guard: fetch()'s real contract never resolves to a
    // falsy value -- it either resolves to a real Response or the promise
    // rejects, which the surrounding try/catch already handles.
    if (!response.ok) {
      throw new Error(`flags endpoint returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      flags?: Record<string, { enabled?: boolean } | undefined>;
    };
    const value = payload?.flags?.[flagKey]?.enabled === true;

    await writeCache(env, flagKey, { value, fetchedAt: now() });
    return value;
  } catch (err) {
    console.error(`[feature-flags] evaluate("${flagKey}") failed:`, err);
    return cached ? cached.value : defaultValue;
  }
}
