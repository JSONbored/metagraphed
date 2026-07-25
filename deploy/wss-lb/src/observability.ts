// PostHog error tracking for wss-lb. Reports to the consolidated PostHog
// project (metagraphed-infra#158/#160's consolidation, matching the
// canonical metagraphed repo's own scripts/observability.ts). Silently
// no-ops if POSTHOG_PROJECT_TOKEN is unset, matching this service's own
// best-effort design elsewhere.
//
// metagraphed#7766: Sentry fully removed here. This is one of the last
// Sentry footprints in the metagraphed project (deploy/wss-lb/ is a
// separate Node service, still deployed via Railway rather than as a
// Cloudflare Worker -- see server.ts's own header) -- unlike the Workers/UI
// error-tracking sub-issues (#7758/#7759), this had no parallel-run phase
// of its own before now; PostHog replaces Sentry directly here.
//
// A separate module from server.ts (not inlined) so the pure aggregate-
// reporting logic below can be unit-tested with `node --test` the same way
// select.ts/proxy.ts already are, without importing server.ts itself --
// that file runs its HTTP server + refresh loop as an unconditional
// top-level side effect on import, so it can't be required by a test file
// directly (see server.ts's own header).
import { PostHog } from "posthog-node";

// Session model here is process-lifetime, not per-run (contrast the
// canonical metagraphed repo's scripts/observability.ts, which sessions per
// script run): this is an always-on server, so "session" only ever matters
// as "capture a fatal before this process dies," not a release-health
// concept PostHog doesn't have a first-class equivalent for anyway (see
// scripts/observability.ts's own header in the canonical repo for the same
// note). handleFatal below owns the crash path itself: this server has no
// single top-level main().catch() boundary every crash funnels through
// (any of its event handlers -- the HTTP server, the WS upgrade handler,
// the refresh/heartbeat intervals -- could throw directly to the process
// level), so uncaughtException/unhandledRejection handlers are registered
// unconditionally here.
let posthogClient: PostHog | undefined;

// Stable, shared distinct_id -- matches the canonical repo's
// scripts/observability.ts's own POSTHOG_DISTINCT_ID convention.
const POSTHOG_DISTINCT_ID = "metagraphed-infra";

async function handleFatal(error: unknown, exitCode: number) {
  console.error("[wss-lb] fatal:", error);
  if (posthogClient) {
    // Immediate (awaited), not the fire-and-forget capture the aggregate
    // reporters below use -- the process exits right after this, so the
    // event must be sent before shutdown() tears the client down, not just
    // queued.
    await posthogClient.captureExceptionImmediate(error, POSTHOG_DISTINCT_ID, {
      component: "wss-lb",
    });
    await posthogClient.shutdown();
  }
  process.exit(exitCode);
}

export function initObservability() {
  const posthogToken = process.env.POSTHOG_PROJECT_TOKEN;
  if (!posthogToken) return;

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

// Shuts the PostHog client down cleanly. Called from server.ts's own
// graceful SIGTERM/SIGINT handler.
export async function endSessionAndFlush() {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}

// PostHog's error-tracking product is exception-shaped, with no first-class
// "message" severity concept -- each aggregate reporter below wraps its
// message text in a synthetic Error. Fire-and-forget (not the Immediate/
// awaited variant) -- these fire mid-request/mid-refresh-tick, not right
// before process exit, so there's no shutdown race to guard against the
// way handleFatal's capture needs.
function capturePostHogEvent(
  message: string,
  properties: Record<string, unknown>,
): void {
  if (!posthogClient) return;
  posthogClient.captureException(new Error(message), POSTHOG_DISTINCT_ID, {
    component: "wss-lb",
    ...properties,
  });
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

// Pure state-transition function -- same design as the canonical repo's
// scripts/chain-firehose-relay.ts's computeDropWindowUpdate, for the same
// reason: a client-connect storm during a real upstream-pool outage could
// reject many clients per second (every concurrent reconnect attempt), and
// naive per-rejection capture would blow through the free-tier event quota
// and then be silently sampled away -- the opposite of the point. Holds no
// module-level mutable state itself; the caller (server.ts) owns the actual
// window variable, the same split chain-firehose-relay.ts's own comment
// explains.
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
  const message = `wss-lb: ${update.count} client(s) rejected for no available upstream (last network: ${update.lastNetwork}) in the last ${Math.round(update.elapsedMs / 1000)}s`;
  capturePostHogEvent(message, {
    level: "warning",
    count: update.count,
    lastNetwork: update.lastNetwork,
    windowMs: update.elapsedMs,
  });
}

// Pool freshness is a LEVEL, not a per-check event -- report only on the
// fresh→stale EDGE (server.ts tracks the previous state and calls this once
// per transition), not on every refresh tick while already stale, which
// would spam once per REFRESH_MS for the entire duration of an outage.
export function reportPoolStale(reason: string) {
  capturePostHogEvent(`wss-lb: RPC pool refresh is stale -- ${reason}`, {
    level: "warning",
  });
}
