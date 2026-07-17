// Box-side relay for the realtime chain-event firehose (#4981, #5027, ADR
// 0015).
//
// A tiny always-on process: polls/claims pending rows from the indexer box's
// own Postgres chain_firehose_outbox table (deploy/postgres/schema.sql's
// enqueue_chain_firehose() trigger, #4980/#5027), and forwards each to the
// Cloudflare Durable Object's ingest endpoint (workers/chain-firehose-hub.mjs,
// #4982) over HTTPS. Does NOT use LISTEN/NOTIFY -- #5027 replaced that
// entirely because Postgres checks NOTIFY-queue capacity at transaction
// commit, outside any trigger-local EXCEPTION block, so a stuck listener
// could pin the queue and fail indexer-rs's own writer transactions. Polling
// a normal table carries no equivalent risk.
//
// Deliberately a PURE consumer: it opens its own dedicated Postgres
// connection, only ever UPDATEs chain_firehose_outbox rows it has itself
// claimed, and is never in indexer-rs's critical path -- unlike the retired
// metagraphed-streamer (docs/adr/0014, whose synchronous push from the
// live-follow process into a blocking write path starved the same connection
// servicing the chain-head subscription), a stalled or unreachable ingest
// endpoint here can only ever stall THIS process's own best-effort
// forwarding, never indexer-rs's writes or Postgres's durability. Best-effort
// by design: the firehose has no durability guarantee (see
// docs/realtime-firehose.md) -- a payload that can't be forwarded after a
// bounded number of retries is dropped, not retried forever, though (unlike
// the old NOTIFY design) it does survive this process being down or
// restarting, since it stays in the outbox until claimed.
//
// Deployed the same way the retired streamer was: an Ansible role in
// JSONbored/metagraphed-infra (roles/chain-firehose-relay/) builds
// deploy/chain-firehose-relay.Dockerfile directly on the indexer box. That
// image clones this repo fresh at container start (metagraphed#6451) rather
// than baking this script in at build time -- see that Dockerfile's own
// header comment.
//
// Run: DATABASE_URL=... CHAIN_FIREHOSE_INGEST_URL=... \
//      CHAIN_FIREHOSE_SYNC_SECRET=... node scripts/chain-firehose-relay.mjs

import { writeFileSync, statSync } from "node:fs";
import postgres from "postgres";
import * as Sentry from "@sentry/node";

// Reports to the consolidated `metagraphed` Sentry project. Silently no-ops
// if SENTRY_DSN is unset, matching this relay's own best-effort design.
//
// Deliberately NOT one captureMessage per dropped payload -- a real 2026-07
// incident (a rate-limit thundering-herd loop this same fix addresses) hit
// millions of drops over ~40 hours; naive per-drop capture would have blown
// through the free-tier event quota in minutes and then been silently
// SAMPLED AWAY by Sentry itself, hiding the incident rather than surfacing
// it -- the opposite of the point. computeDropWindowUpdate() below (called
// from main()'s poll loop, which owns the actual Sentry.captureMessage call)
// aggregates instead: one event per CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD
// drops accumulated, or after CHAIN_FIREHOSE_DROP_REPORT_INTERVAL_MS of any
// nonzero drop rate, whichever comes first (so a persistent-but-low-volume
// problem is never silent forever either) -- the same "escalate
// periodically, don't spam" shape as roles/validator-ops/watchdog.py's own
// re-alert logic in metagraphed-infra. Exported for direct testing rather
// than only indirectly via main()'s own /* v8 ignore */ boundary.
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || "production",
    release: process.env.SENTRY_RELEASE, // deployed git SHA
    tracesSampleRate: 0,
  });
  Sentry.setTag("component", "chain-firehose-relay");
}

export const CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD = 500;
export const CHAIN_FIREHOSE_DROP_REPORT_INTERVAL_MS = 5 * 60 * 1000;

// Pure state-transition function: given the current drop-reporting window
// (or null, before any drops this run) and a new batch's drop count, returns
// whether the window's count/time threshold is now crossed and what the next
// window state should be. Deliberately holds NO module-level mutable state
// itself (unlike an earlier draft of this function) -- main()'s poll loop
// owns the actual `dropWindow` variable in its own closure (the same
// pattern it already uses for `lastCleanupAt`/`shuttingDown`), and is the
// only caller that actually invokes Sentry.captureMessage when `report` is
// true. That split is what makes this fully pure and testable with plain
// input/output assertions, no Sentry mocking or test-order dependence
// needed -- module-level mutable state here would leak between unit tests
// unless every test carefully reset it first, which is exactly the bug this
// design avoids.
export function computeDropWindowUpdate(
  window,
  count,
  lastStatus,
  now = Date.now(),
) {
  const startedAt = window?.startedAt ?? now;
  const totalCount = (window?.count ?? 0) + count;
  const elapsedMs = now - startedAt;
  const report =
    totalCount >= CHAIN_FIREHOSE_DROP_REPORT_THRESHOLD ||
    elapsedMs >= CHAIN_FIREHOSE_DROP_REPORT_INTERVAL_MS;
  return {
    report,
    count: totalCount,
    elapsedMs,
    lastStatus,
    // null (not a zeroed window) once reported -- the NEXT drop starts a
    // fresh window from scratch, matching "resets after reporting."
    nextWindow: report ? null : { startedAt, count: totalCount },
  };
}

// A rate-limit pause is naturally low-frequency (each pause is itself at
// least tens of seconds long -- see CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS),
// so unlike drops this is safe to capture directly, one event per pause,
// with no separate aggregation window needed.
export function reportRateLimitPause(pauseMs) {
  Sentry.captureMessage(
    `chain-firehose-relay: rate limited by the ingest endpoint, pausing ${pauseMs}ms`,
    { level: "warning", extra: { pauseMs } },
  );
}

export const CHAIN_FIREHOSE_INGEST_TOKEN_HEADER = "x-chain-firehose-sync-token";
export const DEFAULT_CHAIN_FIREHOSE_INGEST_URL =
  "https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest";

// This relay previously had zero monitoring coverage -- no metrics
// endpoint, nothing in Prometheus/Alertmanager references it, so a
// silently-dead poll loop (a crash-loop, an unnoticed DATABASE_URL change,
// etc.) could go unnoticed indefinitely. HEARTBEAT_FILE is touched on every
// poll loop iteration (regardless of whether it claimed any rows, and
// regardless of forward success/failure -- this tracks "is the poll loop
// still alive," a separate question from "are forwards succeeding," which
// the drop-window Sentry reporting above already covers). The Docker
// HEALTHCHECK in deploy/chain-firehose-relay.Dockerfile reads this file's
// mtime via the --healthcheck CLI flag below; metagraphed-infra's
// docker-container-health-poll.sh then turns the container's own Docker
// health status into a node_exporter textfile metric a real Prometheus
// alert rule can fire on. Deliberately inside the CONTAINER's own
// filesystem (not a bind-mounted host path): avoids any cross-boundary
// write-permission plumbing between this container's non-root uid and
// node_exporter's host-side textfile collector directory.
//
// Ported from metagraphed-infra's own copy of this script
// (metagraphed-infra#63), which had drifted this feature in independently
// -- landed there directly instead of here first -- and would otherwise
// have been silently lost once metagraphed-infra stopped tracking its own
// copy of this file (metagraphed#6451). Adapted for the outbox-poll loop
// this script now runs (touched once per poll iteration) instead of the
// retired LISTEN subscription (originally touched once per NOTIFY).
export const HEARTBEAT_FILE = "/tmp/chain-firehose-relay-heartbeat";
// Generous over CHAIN_FIREHOSE_POLL_INTERVAL_MS (250ms) and even a full
// rate-limit pause (capped at CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS, 5min)
// -- tolerates a complete rate-limit recovery cycle plus margin before
// flagging unhealthy, so this never false-alarms on the exact recovery
// behavior the poll loop is supposed to do.
export const HEARTBEAT_STALE_MS = 10 * 60 * 1000;

export function touchHeartbeat(path = HEARTBEAT_FILE) {
  // Best-effort -- a heartbeat-write failure must never crash the relay's
  // actual job (forwarding payloads). Falls back to letting the
  // HEALTHCHECK go unhealthy (visible) rather than silently swallowing a
  // real filesystem problem some other way.
  try {
    writeFileSync(path, String(Date.now()));
  } catch (error) {
    console.error("[chain-firehose-relay] failed to write heartbeat:", error);
  }
}

export function isHeartbeatFresh(
  path = HEARTBEAT_FILE,
  now = Date.now(),
  maxAgeMs = HEARTBEAT_STALE_MS,
) {
  try {
    return now - statSync(path).mtimeMs < maxAgeMs;
  } catch {
    return false; // no heartbeat file yet (e.g. still starting up) -- not fresh
  }
}

// How many outbox rows to claim per poll -- bounds one iteration's worth of
// sequential forwarding work, the same role CHAIN_FIREHOSE_QUEUE_MAX_SIZE
// played for the old in-memory NOTIFY queue. Rows beyond this per poll are
// simply picked up on the next iteration (the outbox itself is the durable
// backlog now, not an in-memory queue), so there's no drop-oldest behavior
// to replicate here.
export const CHAIN_FIREHOSE_POLL_BATCH_SIZE = 200;

// Idle poll interval -- how long to wait before re-polling after a batch came
// back empty. When a poll DOES claim rows, the loop paces itself (see
// computeBatchPaceDelayMs below) instead of either waiting out this idle
// interval or re-polling with no delay at all.
export const CHAIN_FIREHOSE_POLL_INTERVAL_MS = 250;

// Server-side cap this relay must stay under (CHAIN_FIREHOSE_INGEST_RATE_LIMIT
// in workers/api.mjs: 1200 req/60s, per-IP). Targets 80% of it, not the full
// 1200, so ordinary jitter (network latency variance, GC pauses, the
// window's own boundary behavior) doesn't tip a batch over the edge even
// when this pacing is working correctly.
export const CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S = 960;

// Pure: how long to additionally sleep after a non-rate-limited batch of
// `claimed` rows took `elapsedMs` wall-clock time to forward, so the
// SUSTAINED rate across batches never organically bursts past the ingest
// endpoint's own rate limit. This is the fix for a real 2026-07-17 incident,
// distinct from the retry-after fix above (that one handles a single 429
// correctly; this one prevents the NEXT batch from re-triggering one at all).
// The prior design re-polled immediately whenever a batch wasn't rate
// limited, so any real backlog fired CHAIN_FIREHOSE_POLL_BATCH_SIZE (200)
// requests in a couple of seconds -- roughly 8x the sustained rate the limit
// allows -- guaranteeing the VERY NEXT batch re-triggered the same 429. The
// relay then correctly paused for retry-after, resumed, immediately
// re-burst, and repeated forever: a livelock reactive backoff alone can
// never recover from, because every retry attempt is already over the limit
// before the first response even comes back. Confirmed live: a real backlog
// sat at ~230k pending with a 100% 429 rate for over an hour until this fix.
// Proactive pacing keeps the relay's own request rate under the cap in the
// first place, so backlog draining converges instead of oscillating forever.
export function computeBatchPaceDelayMs(claimed, elapsedMs) {
  if (claimed <= 0) return 0;
  const targetMs =
    (claimed / CHAIN_FIREHOSE_SAFE_FORWARD_RATE_PER_60S) * 60_000;
  return Math.max(0, targetMs - elapsedMs);
}

// How long a row stays in the outbox before cleanup deletes it. Delivered
// rows are only retained for observability, while pending rows older than
// this have exceeded the firehose's best-effort window and are pruned so a
// wedged relay/downstream cannot accumulate unbounded durable backlog.
export const CHAIN_FIREHOSE_OUTBOX_RETENTION_MS = 60 * 60 * 1000;

// Cleanup runs on its own cadence, independent of the poll loop's busy/idle
// state -- deleting old delivered rows is unrelated to whether new ones are
// currently arriving.
export const CHAIN_FIREHOSE_CLEANUP_INTERVAL_MS = 60 * 1000;

// A notification is retried this many times (with backoff) before being
// dropped -- best-effort, not at-least-once (see this module's header).
export const CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS = 3;
export const CHAIN_FIREHOSE_BACKOFF_BASE_MS = 500;
export const CHAIN_FIREHOSE_BACKOFF_MAX_MS = 15_000;
export const CHAIN_FIREHOSE_FORWARD_TIMEOUT_MS = 10_000;

// forwardBatch's in-flight concurrency -- forwarding a CHAIN_FIREHOSE_POLL_BATCH_SIZE
// batch one row at a time (matching src/webhooks.mjs's own ALERT_DELIVERY_CONCURRENCY
// default) would take minutes to drain any real backlog (each row is a real
// HTTP round trip); this is the ingest endpoint's own Worker, not an
// arbitrary third-party webhook, so higher concurrency than that 8 is
// reasonable. Forwarding is no longer strictly ordered across a batch as a
// result -- acceptable for a best-effort live stream where consumers already
// have block_number/observed_at to reconstruct order if they need to, not
// acceptable to trade away for a queue that can take an hour to catch up
// after downtime.
export const CHAIN_FIREHOSE_FORWARD_CONCURRENCY = 16;

// --- pure, unit-tested logic ----------------------------------------------------

// Bounded-concurrency map: drains `items` through at most `concurrency`
// in-flight `fn` calls. Duplicated from src/webhooks.mjs's own mapBounded
// (not imported) -- this script is deployed standalone, COPYing only itself
// into a minimal container (deploy/chain-firehose-relay.Dockerfile's own
// comment: "a single small ESM file + one npm dependency"); pulling in `src/`
// would grow that deploy surface for a ~15-line utility.
export async function mapBounded(items, concurrency, fn) {
  const list = [...(items || [])];
  const results = new Array(list.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(list[index]);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, list.length)) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

// Validates the process env this relay needs. Throws (rather than returning
// a result object) so a misconfigured deploy fails loudly at startup instead
// of silently no-op'ing -- there's no partial-config mode worth degrading to.
export function parseRelayConfig(env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const syncSecret = env.CHAIN_FIREHOSE_SYNC_SECRET;
  if (!syncSecret) {
    throw new Error("CHAIN_FIREHOSE_SYNC_SECRET is required");
  }
  const ingestUrl =
    env.CHAIN_FIREHOSE_INGEST_URL || DEFAULT_CHAIN_FIREHOSE_INGEST_URL;
  return { databaseUrl, syncSecret, ingestUrl };
}

// Exponential backoff, capped -- attempt is 0-indexed (the first retry after
// an initial failed attempt).
export function computeBackoffDelayMs(
  attempt,
  {
    baseMs = CHAIN_FIREHOSE_BACKOFF_BASE_MS,
    maxMs = CHAIN_FIREHOSE_BACKOFF_MAX_MS,
  } = {},
) {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

// Ceiling on how long a single retry-after value can pause the relay for --
// protects against a pathological/misconfigured server value stalling the
// relay indefinitely (a real incident's own root cause was the OPPOSITE
// problem -- not respecting retry-after at all -- but an unbounded value
// would just trade one outage shape for another).
export const CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS = 5 * 60 * 1000;
// Used when a 429 response has no (or an unparseable) retry-after header --
// generous over the ingest endpoint's own 60s rate-limit window
// (CHAIN_FIREHOSE_INGEST_RATE_LIMIT in workers/api.mjs) so a fallback pause
// still clears the window rather than immediately re-triggering it.
export const CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS = 65 * 1000;

// Parses a standard `retry-after` header (either an integer number of
// seconds, or an HTTP-date) into a millisecond delay from now. Returns null
// if absent or unparseable -- callers fall back to
// CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS in that case, never to zero
// (silently not backing off at all was the actual root cause of a real
// 2026-07 incident: 429s were retried with the same short generic backoff
// as any other failure, so the relay kept re-triggering the same rate limit
// indefinitely instead of ever recovering).
export function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// Forwards one payload to the hub's ingest endpoint. `fetchImpl` is injected
// so this is testable without a real network call -- the poll loop below is
// the only caller in production. `payload` is the JSON-serialized string
// body, not the parsed object (the caller stringifies chain_firehose_outbox's
// already-parsed JSONB column once, up front). retryAfterMs is only present
// on the result when the response actually carried a retry-after header
// (i.e. never on a 2xx) -- keeps the common-case return shape unchanged.
export async function forwardChainFirehoseNotification(
  payload,
  { ingestUrl, syncSecret },
  fetchImpl = fetch,
) {
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    CHAIN_FIREHOSE_FORWARD_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CHAIN_FIREHOSE_INGEST_TOKEN_HEADER]: syncSecret,
      },
      body: payload,
      signal: abortController.signal,
    });
    const retryAfterMs = parseRetryAfterMs(
      response.headers?.get?.("retry-after"),
    );
    const result = {
      ok: response.ok,
      status: response.status,
      ...(retryAfterMs !== null && { retryAfterMs }),
    };
    await response.body?.cancel();
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// Forwards one payload with bounded retry/backoff. Returns true if the
// payload was forwarded successfully, false if it was dropped after
// exhausting CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS -- never throws (a
// forwarding failure must never crash the relay's poll loop). onRateLimited
// (new) fires with the pause duration whenever a 429 is seen, independent of
// whether this particular payload eventually succeeds or gets dropped --
// forwardBatch uses it to pause the WHOLE poll loop, not just this one row's
// own retries, which is the actual fix for the thundering-herd failure mode
// (see forwardBatch's own comment).
export async function forwardWithRetry(
  payload,
  config,
  {
    fetchImpl = fetch,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    onDrop,
    onRateLimited,
  } = {},
) {
  let result;
  for (
    let attempt = 0;
    attempt < CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS;
    attempt += 1
  ) {
    result = undefined; // reset per attempt -- a thrown network error must not let a PRIOR attempt's stale status leak into this one's 429 check below
    try {
      result = await forwardChainFirehoseNotification(
        payload,
        config,
        fetchImpl,
      );
      if (result.ok) return true;
    } catch {
      // network error -- fall through to retry/backoff below
    }
    if (result?.status === 429) {
      const pauseMs = Math.min(
        result.retryAfterMs ?? CHAIN_FIREHOSE_DEFAULT_RATE_LIMIT_PAUSE_MS,
        CHAIN_FIREHOSE_MAX_RATE_LIMIT_PAUSE_MS,
      );
      onRateLimited?.(pauseMs);
      // Do NOT also apply the generic exponential backoff below -- a 429
      // means "you are over the limit right now," not "this one request
      // had a transient blip." Retrying again within the same rate-limit
      // window (which the generic 500ms/1s backoff would do) just adds
      // another rejected request, never recovers anything.
      if (attempt < CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS - 1) {
        await sleepImpl(pauseMs);
      }
      continue;
    }
    if (attempt < CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS - 1) {
      await sleepImpl(computeBackoffDelayMs(attempt));
    }
  }
  // lastStatus is the last-observed HTTP status across all attempts (undefined
  // if every attempt threw a network error rather than getting a response) --
  // extra context for onDrop's aggregate reporting, not part of the original
  // (payload)-only contract, so existing callers that ignore the second
  // argument are unaffected.
  onDrop?.(payload, result?.status);
  return false;
}

// Forwards every row in a claimed batch with bounded concurrency (see
// CHAIN_FIREHOSE_FORWARD_CONCURRENCY's own comment for why this isn't
// sequential). `rows` are already claimed (delivered_at stamped) by the
// caller's UPDATE ... RETURNING before this runs -- forwarding failure after
// exhausting retries still counts as "handled" (best-effort, not
// at-least-once, same as the old design), not re-queued.
//
// rateLimitedForMs (new): the MAX pause duration reported by any row in this
// batch, if any hit a 429 -- the caller (main()'s poll loop) sleeps this long
// before its NEXT poll rather than immediately re-claiming a fresh batch and
// firing CHAIN_FIREHOSE_FORWARD_CONCURRENCY more requests straight into the
// same rate limit. This is the actual fix for the real 2026-07 incident: 16
// concurrent requests times however many batches per second the old
// immediate-reloop behavior fired is trivially over the ingest endpoint's
// own 120-req/60s limit the moment there's any real backlog, and every prior
// design only backed off PER ROW, never paused the batch/poll level that was
// the true source of the overload.
export async function forwardBatch(rows, config, options = {}) {
  let rateLimitedForMs = 0;
  const results = await mapBounded(
    rows,
    CHAIN_FIREHOSE_FORWARD_CONCURRENCY,
    (row) =>
      forwardWithRetry(JSON.stringify(row.payload), config, {
        ...options,
        onRateLimited: (pauseMs) => {
          rateLimitedForMs = Math.max(rateLimitedForMs, pauseMs);
          options.onRateLimited?.(pauseMs);
        },
      }),
  );
  const forwarded = results.filter(Boolean).length;
  return {
    forwarded,
    dropped: results.length - forwarded,
    ...(rateLimitedForMs > 0 && { rateLimitedForMs }),
  };
}

/* v8 ignore start -- the long-running poll/cleanup loop needs a real
   Postgres connection and process lifecycle (SIGTERM/SIGINT); every decision
   it makes (config validation, backoff timing, retry count, batch
   forwarding) is delegated to the pure functions above and unit-tested
   directly (see tests/chain-firehose-relay.test.mjs). This file is
   intentionally outside vitest.config.mjs's coverage.include, matching every
   other standalone deploy/-tier process in this repo (e.g. deploy/wss-lb,
   tested via `node --test` instead) -- see that config's own comment for the
   convention. */
async function main() {
  initSentry();
  const config = parseRelayConfig(process.env);
  const sql = postgres(config.databaseUrl);
  let shuttingDown = false;
  let dropWindow = null; // owned here, not module-level -- see computeDropWindowUpdate's own comment

  const shutdown = async () => {
    shuttingDown = true;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Claims up to CHAIN_FIREHOSE_POLL_BATCH_SIZE pending rows in one atomic
  // UPDATE ... RETURNING (SKIP LOCKED so a concurrently-running second relay
  // instance -- a brief overlap during a redeploy -- claims disjoint rows
  // instead of racing on the same ones), stamping delivered_at as the claim
  // marker before any HTTP forwarding happens. Returns the pause duration
  // (ms) the caller should sleep before the NEXT poll if this batch hit the
  // ingest endpoint's rate limit -- see forwardBatch's own comment for why
  // this is the actual fix, not just per-row retry backoff.
  async function pollOnce() {
    const rows = await sql`
      UPDATE chain_firehose_outbox
      SET delivered_at = now()
      WHERE id IN (
        SELECT id FROM chain_firehose_outbox
        WHERE delivered_at IS NULL
        ORDER BY id
        LIMIT ${CHAIN_FIREHOSE_POLL_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, payload`;
    if (rows.length === 0) return { claimed: 0, rateLimitedForMs: 0 };
    let droppedInBatch = 0;
    let lastDropStatus;
    const result = await forwardBatch(rows, config, {
      onDrop: (_payload, status) => {
        droppedInBatch += 1;
        lastDropStatus = status;
      },
    });
    if (droppedInBatch > 0) {
      console.error(
        `[chain-firehose-relay] dropped ${droppedInBatch}/${rows.length} payloads this batch after ${CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS} attempts each (last status: ${lastDropStatus ?? "network error"})`,
      );
      const update = computeDropWindowUpdate(
        dropWindow,
        droppedInBatch,
        lastDropStatus,
      );
      dropWindow = update.nextWindow;
      if (update.report) {
        Sentry.captureMessage(
          `chain-firehose-relay: ${update.count} payload(s) dropped in the last ${Math.round(update.elapsedMs / 1000)}s (last status: ${update.lastStatus ?? "network error"})`,
          {
            level: "warning",
            extra: {
              count: update.count,
              lastStatus: update.lastStatus,
              windowMs: update.elapsedMs,
            },
          },
        );
      }
    }
    return {
      claimed: rows.length,
      rateLimitedForMs: result.rateLimitedForMs ?? 0,
    };
  }

  async function cleanupOnce() {
    const cutoff = new Date(Date.now() - CHAIN_FIREHOSE_OUTBOX_RETENTION_MS);
    await sql`
      DELETE FROM chain_firehose_outbox
      WHERE (delivered_at IS NOT NULL AND delivered_at < ${cutoff})
         OR (delivered_at IS NULL AND created_at < ${cutoff})`;
  }

  let lastCleanupAt = Date.now();
  touchHeartbeat(); // write once at startup so HEALTHCHECK's --start-period grace doesn't immediately expire on a quiet first poll
  console.log(
    `[chain-firehose-relay] polling chain_firehose_outbox every ${CHAIN_FIREHOSE_POLL_INTERVAL_MS}ms, forwarding to ${config.ingestUrl}`,
  );
  while (!shuttingDown) {
    const pollStartedAt = Date.now();
    const { claimed, rateLimitedForMs } = await pollOnce();
    touchHeartbeat(); // tracks poll-loop liveness, independent of claim/forward outcome -- see HEARTBEAT_FILE's own comment
    if (Date.now() - lastCleanupAt >= CHAIN_FIREHOSE_CLEANUP_INTERVAL_MS) {
      await cleanupOnce();
      lastCleanupAt = Date.now();
    }
    if (rateLimitedForMs > 0) {
      // Pause the WHOLE poll loop for the ingest endpoint's own stated
      // recovery window instead of immediately claiming and firing another
      // CHAIN_FIREHOSE_FORWARD_CONCURRENCY batch straight into the same rate
      // limit. Reported once per pause (not per dropped row -- see
      // reportRateLimitPause's own comment) so this is visible without
      // becoming its own flood.
      console.error(
        `[chain-firehose-relay] rate limited by the ingest endpoint -- pausing ${rateLimitedForMs}ms before the next poll`,
      );
      reportRateLimitPause(rateLimitedForMs);
      await new Promise((resolve) => setTimeout(resolve, rateLimitedForMs));
    } else if (claimed === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, CHAIN_FIREHOSE_POLL_INTERVAL_MS),
      );
    } else {
      // claimed > 0 and not rate limited: pace the next poll instead of
      // looping immediately -- see computeBatchPaceDelayMs's own comment for
      // why an unpaced immediate reloop reliably re-triggers the same 429
      // this batch just avoided.
      const paceDelayMs = computeBatchPaceDelayMs(
        claimed,
        Date.now() - pollStartedAt,
      );
      if (paceDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, paceDelayMs));
      }
    }
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--healthcheck")) {
    // Docker HEALTHCHECK entry point (see
    // deploy/chain-firehose-relay.Dockerfile) -- reuses this same
    // image/script rather than a separate file. isHeartbeatFresh's pure
    // logic is unit-tested directly; this just wires it to a process exit
    // code, which is all HEALTHCHECK actually reads.
    process.exit(isHeartbeatFresh() ? 0 : 1);
  } else {
    main().catch(async (error) => {
      console.error("[chain-firehose-relay] fatal:", error);
      // Explicitly caught here, so @sentry/node's default
      // OnUnhandledRejection integration never sees this -- Node does not
      // consider a promise "unhandled" once something calls .catch() on it.
      // flush() before process.exit(1) is required: process.exit() is
      // synchronous and does not wait for Sentry's background network send.
      Sentry.captureException(error);
      await Sentry.flush(2000);
      process.exit(1);
    });
  }
}
/* v8 ignore stop */
