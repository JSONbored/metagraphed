// Shared Sentry + PostHog init for the box-side Node data-refresh scripts
// run via metagraphed-infra's data-refresh-economics/data-refresh-node
// Ansible roles (scripts/economics-refresh-entrypoint.sh /
// data-refresh-node-entrypoint.sh, both of which clone this repo at
// container runtime -- see those entrypoints' own headers), plus a couple of
// Cloudflare-publish-side build steps that fit the same "short-lived batch
// script" shape. Used by refresh-economics.ts, refresh-native-snapshot.ts,
// backfill-registry-postgres.ts, discover-testnet-surfaces.ts,
// export-parquet.ts, reconcile-neurons.ts, sync-registry-to-postgres.ts,
// and refresh-og-image.ts so all eight report to the same consolidated
// `metagraphed` Sentry project (with a consistent `component` tag) and the
// same PostHog project (metagraphed-infra#158/#160's consolidation) in
// parallel -- additive, not a replacement; Sentry stays until a separate,
// gated decommission (matching the public repo's own #7766 posture).
//
// scripts/observability.py's Python-side equivalent (originally used by the
// now-retired data-refresh-cron fetch scripts, metagraphed-infra#141) has
// no live caller as of 2026-07-24 -- deliberately NOT given the same
// PostHog treatment here, since there's nothing left to instrument.
import { closeSession } from "@sentry/core";
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";

// Release-health session tracking (Sentry's "Crash Free Sessions/Users"
// widgets). @sentry/node's own default OnUncaughtException/
// OnUnhandledRejection integrations do NOT mark the active session as
// crashed before exiting -- confirmed by reading their actual source
// (node_modules/@sentry/node-core/build/*/integrations/onuncaughtexception.js
// touches no session state at all), despite Sentry's own docs implying a
// crash marks the session automatically. Rather than ship a metric that's
// silently wrong (always "healthy" even on a real crash), this module owns
// the crash path itself end-to-end: registers its own handlers BEFORE
// Sentry.init() runs (Node calls uncaughtException/unhandledRejection
// listeners in registration order, so this one must fire first), and
// filters Sentry's own two crash-handling integrations out of the default
// set so there's no race between two competing exit paths.
//
// Session model here is per SCRIPT RUN (start in initSentry, end via
// endSessionAndFlush on the clean-exit path) -- these are one-shot
// processes, not request-serving services, so "session" == "did this run
// complete without an unhandled error," not a user session.
let sentryInitialized = false;
let posthogClient: PostHog | undefined;

// Stable, shared distinct_id for every box-side script -- these are
// unattended batch/service processes with no real end user, matching
// USAGE_EVENT_DISTINCT_ID's own "one identity per logical source"
// convention on the Workers side (src/usage-telemetry.ts).
const POSTHOG_DISTINCT_ID = "metagraphed-infra";

async function handleFatal(error: unknown, exitCode: number): Promise<void> {
  console.error("[observability] fatal:", error);
  if (sentryInitialized) {
    Sentry.captureException(error);
    const session = Sentry.getIsolationScope().getSession();
    if (session) {
      closeSession(session, "crashed");
      Sentry.captureSession();
    }
    await Sentry.flush(2000);
  }
  if (posthogClient) {
    // Immediate (awaited), not the fire-and-forget captureException -- the
    // process exits right after this, so the event must be sent before
    // shutdown() tears the client down, not just queued.
    await posthogClient.captureExceptionImmediate(error, POSTHOG_DISTINCT_ID);
    await posthogClient.shutdown();
  }
  process.exit(exitCode);
}

// No-ops the Sentry half if SENTRY_DSN is unset, and independently no-ops
// the PostHog half if POSTHOG_PROJECT_TOKEN is unset -- either, both, or
// neither may be configured (metagraphed-infra#158). Neither is a secret in
// the same sense a sync token is (both are designed to be safe in client-
// side/public code, write-only), so passing them into these scripts'
// existing "gets zero secrets" trust boundaries where applicable doesn't
// weaken them.
export function initSentry(component: string): void {
  const dsn = process.env.SENTRY_DSN;
  const posthogToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!dsn && !posthogToken) return;

  // Registered before Sentry.init() -- see this module's own header for why
  // ordering matters here. Needed whenever EITHER backend is configured, not
  // gated on Sentry alone -- a PostHog-only run still needs handleFatal to
  // run on an uncaught exception.
  process.on("uncaughtException", (error) => {
    handleFatal(error, 1);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatal(
      reason instanceof Error ? reason : new Error(String(reason)),
      1,
    );
  });

  if (posthogToken) {
    posthogClient = new PostHog(posthogToken, {
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
    });
  }

  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    release: process.env.SENTRY_RELEASE, // set by the entrypoint's own git rev-parse
    // Error tracking only -- these are short-lived batch scripts run on a
    // 3min/daily/weekly cron, not request-serving services.
    tracesSampleRate: 0,
    // Also filters out the default ProcessSession integration -- it calls
    // startSession() itself during Sentry.init(), which our own
    // Sentry.startSession() call below would otherwise immediately end
    // (reporting a spurious extra "exited" session on every single run) and
    // replace, rather than there being exactly one session per run as
    // intended. Confirmed empirically: without this, every run sent two
    // session envelopes instead of one.
    integrations: (integrations) =>
      integrations.filter(
        (integration) =>
          integration.name !== "OnUncaughtException" &&
          integration.name !== "OnUnhandledRejection" &&
          integration.name !== "ProcessSession",
      ),
  });
  Sentry.setTag("component", component);
  sentryInitialized = true;
  Sentry.startSession();
}

// Call on the clean-exit path (end of a successful run) so the session
// reports "exited" (healthy) rather than being left open indefinitely, and
// so the PostHog client shuts down cleanly (releases its background flush
// timer rather than holding the process open past a natural exit). Each
// backend's cleanup is gated on its OWN init state independently -- a
// PostHog-only run (no SENTRY_DSN) must still shut down its client here.
export async function endSessionAndFlush() {
  if (sentryInitialized) {
    Sentry.endSession();
    await Sentry.flush(2000);
  }
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}

// For the one script with its own explicit top-level `.catch()`
// (discover-testnet-surfaces.ts): Node stops considering a promise
// "unhandled" once something calls .catch() on it, so that script calls
// this directly instead of relying on the uncaughtException/
// unhandledRejection handlers above.
export async function captureFatalAndExit(
  error: unknown,
  exitCode = 1,
): Promise<void> {
  await handleFatal(error, exitCode);
}
