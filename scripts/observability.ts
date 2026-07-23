// Shared Sentry init for the box-side Node data-refresh scripts run via
// metagraphed-infra's data-refresh-economics/data-refresh-node Ansible
// roles (scripts/economics-refresh-entrypoint.sh /
// data-refresh-node-entrypoint.sh, both of which clone this repo at
// container runtime -- see those entrypoints' own headers), plus a couple of
// Cloudflare-publish-side build steps that fit the same "short-lived batch
// script" shape. Used by refresh-economics.ts, refresh-native-snapshot.mjs,
// backfill-registry-postgres.ts, discover-testnet-surfaces.ts,
// export-parquet.ts, reconcile-neurons.ts, sync-registry-to-postgres.mjs,
// and refresh-og-image.mjs so all eight report to the same consolidated
// `metagraphed` Sentry project with a consistent `component` tag --
// matching scripts/observability.py's own Python-side convention for the
// chain-fetch scripts.
import { closeSession } from "@sentry/core";
import * as Sentry from "@sentry/node";

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
  process.exit(exitCode);
}

// No-ops silently if SENTRY_DSN is unset, matching every other
// instrumented process in this rollout (SENTRY_DSN is not a secret in the
// same sense a sync token is -- Sentry DSNs are designed to be safe in
// client-side/public code, write-only -- so passing it into these scripts'
// existing "gets zero secrets" trust boundaries where applicable doesn't
// weaken them).
export function initSentry(component: string): void {
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
// reports "exited" (healthy) rather than being left open indefinitely.
// Safe to call even if initSentry() no-op'd (no DSN) -- Sentry's own
// endSession()/flush() are documented no-ops before init.
export async function endSessionAndFlush() {
  if (!sentryInitialized) return;
  Sentry.endSession();
  await Sentry.flush(2000);
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
