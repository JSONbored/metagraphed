// Sentry error tracking for wss-lb (ADR 0013). Reports to the consolidated
// `metagraphed` Sentry project. Silently no-ops if SENTRY_DSN is unset,
// matching this service's own best-effort design elsewhere.
//
// A separate module from server.ts (not inlined) so the pure aggregate-
// reporting logic below can be unit-tested with `node --test` the same way
// select.ts/proxy.ts already are, without importing server.ts itself --
// that file runs its HTTP server + refresh loop as an unconditional
// top-level side effect on import, so it can't be required by a test file
// directly (see server.ts's own header).
import { closeSession } from "@sentry/core";
import * as Sentry from "@sentry/node";

// Release-health session tracking (Crash Free Sessions/Users), process-
// lifetime model: this is an always-on server, not a one-shot batch script
// (contrast the canonical metagraphed repo's scripts/observability.ts,
// which sessions per script run) -- one session per process boot, closed
// healthy on graceful SIGTERM/SIGINT shutdown (see server.ts's own
// shutdown handler) or marked crashed here on a genuinely uncaught
// exception. @sentry/node's default OnUncaughtException/OnUnhandledRejection
// integrations don't mark the active session crashed before exiting
// (confirmed by reading node_modules/@sentry/node-core's actual source --
// same finding scripts/observability.ts's own header documents), and unlike
// scripts/chain-firehose-relay.ts this server has no single top-level
// main().catch() boundary every crash funnels through (any of its event
// handlers -- the HTTP server, the WS upgrade handler, the refresh/heartbeat
// intervals -- could throw directly to the process level), so this module
// owns the crash path itself: handlers registered before Sentry.init() runs
// (Node calls uncaughtException/unhandledRejection listeners in registration
// order), with those two default integrations filtered out so there's no
// race between two competing exit paths.
let sentryInitialized = false;

async function handleFatal(error: unknown, exitCode: number) {
  console.error("[wss-lb] fatal:", error);
  if (sentryInitialized) {
    Sentry.captureException(error);
    const session = Sentry.getIsolationScope().getSession();
    if (session) {
      closeSession(session, "crashed");
      Sentry.captureSession();
    }
    await Sentry.flush(2000);
  }
  process.exit(exitCode);
}

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  // Registered before Sentry.init() -- see this module's own header for why
  // ordering matters here.
  process.on("uncaughtException", (error) => {
    handleFatal(error, 1);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatal(
      reason instanceof Error ? reason : new Error(String(reason)),
      1,
    );
  });

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
    // Also filters out the default ProcessSession integration -- it calls
    // startSession() itself during Sentry.init(), which our own
    // Sentry.startSession() call below would otherwise immediately end
    // (reporting a spurious extra "exited" session on every single process
    // boot) and replace, rather than there being exactly one session per
    // boot as intended. Confirmed empirically: without this, every boot
    // sent two session envelopes (one "exited", one for this boot's real
    // outcome) instead of one.
    integrations: (integrations) =>
      integrations.filter(
        (integration) =>
          integration.name !== "OnUncaughtException" &&
          integration.name !== "OnUnhandledRejection" &&
          integration.name !== "ProcessSession",
      ),
  });
  Sentry.setTag("component", "wss-lb");
  sentryInitialized = true;
  Sentry.startSession();
}

// Closes the process-lifetime session as a healthy exit. Called from
// server.ts's own graceful SIGTERM/SIGINT handler.
export async function endSessionAndFlush() {
  if (!sentryInitialized) return;
  Sentry.endSession();
  await Sentry.flush(2000);
}

export const NO_UPSTREAM_REPORT_THRESHOLD = 50;
export const NO_UPSTREAM_REPORT_INTERVAL_MS = 5 * 60 * 1000;

export interface NoUpstreamWindow {
  startedAt: number;
  count: number;
}

export interface NoUpstreamWindowUpdate {
  report: boolean;
  count: number;
  elapsedMs: number;
  lastNetwork: string;
  nextWindow: NoUpstreamWindow | null;
}

// Pure state-transition function -- same design as chain-firehose-relay.ts's
// computeDropWindowUpdate, for the same reason: a client-connect storm during
// a real upstream-pool outage could reject many clients per second (every
// concurrent reconnect attempt), and naive per-rejection capture would blow
// through the free-tier Sentry event quota and then be silently sampled away
// by Sentry itself -- the opposite of the point. Holds no module-level
// mutable state itself; the caller (server.ts) owns the actual window
// variable, the same split chain-firehose-relay.ts's own comment explains.
export function computeNoUpstreamWindowUpdate(
  window: NoUpstreamWindow | null | undefined,
  network: string,
  now: number = Date.now(),
): NoUpstreamWindowUpdate {
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

export function reportNoUpstreamWindow(update: NoUpstreamWindowUpdate) {
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
// fresh→stale EDGE (server.ts tracks the previous state and calls this once
// per transition), not on every refresh tick while already stale, which
// would spam once per REFRESH_MS for the entire duration of an outage.
export function reportPoolStale(reason: string) {
  Sentry.captureMessage(`wss-lb: RPC pool refresh is stale -- ${reason}`, {
    level: "warning",
  });
}
