// Shared Sentry init for the box-side Node data-refresh scripts run via
// metagraphed-infra's data-refresh-economics/data-refresh-node Ansible
// roles (scripts/economics-refresh-entrypoint.sh /
// data-refresh-node-entrypoint.sh, both of which clone this repo at
// container runtime -- see those entrypoints' own headers), plus a couple of
// Cloudflare-publish-side build steps that fit the same "short-lived batch
// script" shape. Used by refresh-economics.mjs, refresh-native-snapshot.mjs,
// backfill-registry-postgres.mjs, discover-testnet-surfaces.mjs,
// export-parquet.mjs, reconcile-neurons.mjs, sync-registry-to-postgres.mjs,
// and refresh-og-image.mjs so all eight report to the same consolidated
// `metagraphed` Sentry project with a consistent `component` tag --
// matching scripts/observability.py's own Python-side convention for the
// chain-fetch scripts.
import * as Sentry from "@sentry/node";

// No-ops silently if SENTRY_DSN is unset, matching every other
// instrumented process in this rollout (SENTRY_DSN is not a secret in the
// same sense a sync token is -- Sentry DSNs are designed to be safe in
// client-side/public code, write-only -- so passing it into these scripts'
// existing "gets zero secrets" trust boundaries where applicable doesn't
// weaken them).
export function initSentry(component) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    release: process.env.SENTRY_RELEASE, // set by the entrypoint's own git rev-parse
    // Error tracking only -- these are short-lived batch scripts run on a
    // 3min/daily/weekly cron, not request-serving services.
    tracesSampleRate: 0,
  });
  Sentry.setTag("component", component);
  // Every script this module is used by is a ONE-SHOT process, not a
  // long-running poll loop like chain-firehose-relay.mjs -- an error that
  // propagates uncaught (the common case: most of these scripts have no
  // top-level try/catch at all, relying on Node's own default "print and
  // exit 1" behavior) is automatically captured, flushed, and reported by
  // @sentry/node's own default OnUncaughtException/OnUnhandledRejection
  // integrations, installed as a side effect of Sentry.init() above -- no
  // manual process.on() wiring needed here. The one exception is a script
  // with its OWN explicit top-level `.catch()` (discover-testnet-
  // surfaces.mjs): Node stops considering a promise "unhandled" once
  // something calls .catch() on it, so that one script calls
  // captureFatalAndExit() below directly instead of relying on the default.
}

export async function captureFatalAndExit(error, exitCode = 1) {
  Sentry.captureException(error);
  await Sentry.flush(2000);
  process.exit(exitCode);
}
