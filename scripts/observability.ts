// Shared PostHog init for the box-side Node data-refresh scripts run via
// metagraphed-infra's data-refresh-economics/data-refresh-node Ansible roles
// (scripts/economics-refresh-entrypoint.sh / data-refresh-node-entrypoint.sh,
// both of which clone this repo at container runtime -- see those
// entrypoints' own headers), plus a couple of Cloudflare-publish-side build
// steps that fit the same "short-lived batch script" shape. Used by
// refresh-economics.ts, refresh-native-snapshot.ts,
// backfill-registry-postgres.ts, discover-testnet-surfaces.ts,
// export-parquet.ts, reconcile-neurons.ts, sync-registry-to-postgres.ts, and
// refresh-og-image.ts so all eight report to the same consolidated PostHog
// project (metagraphed-infra#158/#160's consolidation).
//
// metagraphed#7766: Sentry fully removed here (was parallel-run alongside
// PostHog until parity was proven, matching the public repo's own #7766
// posture). scripts/observability.py's Python-side equivalent (originally
// used by the now-retired data-refresh-cron fetch scripts,
// metagraphed-infra#141) has no live caller as of 2026-07-24 -- deliberately
// not given the same PostHog treatment here, since there's nothing left to
// instrument.
import { PostHog } from "posthog-node";

// Session model here is per SCRIPT RUN (start in initObservability, end via
// endSessionAndFlush on the clean-exit path) -- these are one-shot
// processes, not request-serving services, so "session" == "did this run
// complete without an unhandled error," not a user session. PostHog has no
// first-class release-health/session-tracking concept the way Sentry did
// (Crash Free Sessions/Users) -- captureExceptionImmediate on a fatal error
// is the closest available signal, and is what handleFatal below relies on.
let posthogClient: PostHog | undefined;
let currentComponent: string | undefined;

// Stable, shared distinct_id for every box-side script -- these are
// unattended batch/service processes with no real end user, matching
// USAGE_EVENT_DISTINCT_ID's own "one identity per logical source"
// convention on the Workers side (src/usage-telemetry.ts).
const POSTHOG_DISTINCT_ID = "metagraphed-infra";

async function handleFatal(error: unknown, exitCode: number): Promise<void> {
  console.error("[observability] fatal:", error);
  if (posthogClient) {
    // Immediate (awaited), not the fire-and-forget captureException -- the
    // process exits right after this, so the event must be sent before
    // shutdown() tears the client down, not just queued. `component`
    // (initObservability's own arg) rides as a property here -- the closest
    // PostHog equivalent to Sentry's setTag("component", component), so a
    // fatal from any of the eight callers is still filterable by which
    // script produced it.
    await posthogClient.captureExceptionImmediate(error, POSTHOG_DISTINCT_ID, {
      component: currentComponent,
    });
    await posthogClient.shutdown();
  }
  process.exit(exitCode);
}

// No-ops if POSTHOG_PROJECT_TOKEN is unset (metagraphed-infra#158). Not a
// secret in the same sense a sync token is (designed to be safe in client-
// side/public code, write-only), so passing it into these scripts' existing
// "gets zero secrets" trust boundaries where applicable doesn't weaken them.
export function initObservability(component: string): void {
  const posthogToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!posthogToken) return;

  currentComponent = component;
  process.on("uncaughtException", (error) => {
    handleFatal(error, 1);
  });
  process.on("unhandledRejection", (reason) => {
    handleFatal(
      reason instanceof Error ? reason : new Error(String(reason)),
      1,
    );
  });

  posthogClient = new PostHog(posthogToken, {
    host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  });
}

// Call on the clean-exit path (end of a successful run) so the PostHog
// client shuts down cleanly (releases its background flush timer rather
// than holding the process open past a natural exit).
export async function endSessionAndFlush() {
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

// For a script that catches its own failure and continues (exits 0) rather
// than treating it as fatal -- refresh-og-image.ts's tolerant-by-design
// catch (any render failure logs a warning and leaves the previously
// published card in place, never blocks the publish). Same Immediate/
// awaited contract as handleFatal: the caller runs this before its own
// endSessionAndFlush() tears the client down, so the event must be sent
// before shutdown, not just queued -- there is no separate uncaught-fatal
// path to rely on here.
export async function captureExceptionAndContinue(
  error: unknown,
): Promise<void> {
  if (!posthogClient) return;
  await posthogClient.captureExceptionImmediate(error, POSTHOG_DISTINCT_ID, {
    component: currentComponent,
  });
}
