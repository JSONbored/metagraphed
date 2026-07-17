// Sentry error tracking for wss-lb (ADR 0013). Reports to the consolidated
// `metagraphed` Sentry project. Silently no-ops if SENTRY_DSN is unset,
// matching this service's own best-effort design elsewhere.
//
// A separate module from server.mjs (not inlined) so the pure aggregate-
// reporting logic below can be unit-tested with `node --test` the same way
// select.mjs/proxy.mjs already are, without importing server.mjs itself --
// that file runs its HTTP server + refresh loop as an unconditional
// top-level side effect on import, so it can't be required by a test file
// directly (see server.mjs's own header).
import * as Sentry from "@sentry/node";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    // Railway's own commit-SHA env var, injected automatically for a
    // git-based deploy -- no wss-lb-specific entrypoint wiring needed the
    // way the box-side clone-at-runtime scripts require (this service still
    // deploys via Railway, see the Dockerfile's own header). An explicit
    // SENTRY_RELEASE still wins if one is somehow already set.
    release: process.env.SENTRY_RELEASE || process.env.RAILWAY_GIT_COMMIT_SHA,
    tracesSampleRate: 0,
  });
  Sentry.setTag("component", "wss-lb");
}

export const NO_UPSTREAM_REPORT_THRESHOLD = 50;
export const NO_UPSTREAM_REPORT_INTERVAL_MS = 5 * 60 * 1000;

// Pure state-transition function -- same design as chain-firehose-relay.mjs's
// computeDropWindowUpdate, for the same reason: a client-connect storm during
// a real upstream-pool outage could reject many clients per second (every
// concurrent reconnect attempt), and naive per-rejection capture would blow
// through the free-tier Sentry event quota and then be silently sampled away
// by Sentry itself -- the opposite of the point. Holds no module-level
// mutable state itself; the caller (server.mjs) owns the actual window
// variable, the same split chain-firehose-relay.mjs's own comment explains.
export function computeNoUpstreamWindowUpdate(
  window,
  network,
  now = Date.now(),
) {
  const startedAt = window?.startedAt ?? now;
  const totalCount = (window?.count ?? 0) + 1;
  const elapsedMs = now - startedAt;
  const report =
    totalCount >= NO_UPSTREAM_REPORT_THRESHOLD ||
    elapsedMs >= NO_UPSTREAM_REPORT_INTERVAL_MS;
  return {
    report,
    count: totalCount,
    elapsedMs,
    lastNetwork: network,
    nextWindow: report ? null : { startedAt, count: totalCount },
  };
}

export function reportNoUpstreamWindow(update) {
  Sentry.captureMessage(
    `wss-lb: ${update.count} client(s) rejected for no available upstream (last network: ${update.lastNetwork}) in the last ${Math.round(update.elapsedMs / 1000)}s`,
    {
      level: "warning",
      extra: {
        count: update.count,
        lastNetwork: update.lastNetwork,
        windowMs: update.elapsedMs,
      },
    },
  );
}

// Pool freshness is a LEVEL, not a per-check event -- report only on the
// fresh→stale EDGE (server.mjs tracks the previous state and calls this once
// per transition), not on every refresh tick while already stale, which
// would spam once per REFRESH_MS for the entire duration of an outage.
export function reportPoolStale(reason) {
  Sentry.captureMessage(`wss-lb: RPC pool refresh is stale -- ${reason}`, {
    level: "warning",
  });
}
