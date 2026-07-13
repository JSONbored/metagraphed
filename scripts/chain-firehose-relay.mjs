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
// deploy/chain-firehose-relay.Dockerfile directly on the indexer box,
// COPYing this script in. See that Dockerfile's own header comment.
//
// Run: DATABASE_URL=... CHAIN_FIREHOSE_INGEST_URL=... \
//      CHAIN_FIREHOSE_SYNC_SECRET=... node scripts/chain-firehose-relay.mjs

import postgres from "postgres";

export const CHAIN_FIREHOSE_INGEST_TOKEN_HEADER = "x-chain-firehose-sync-token";
export const DEFAULT_CHAIN_FIREHOSE_INGEST_URL =
  "https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest";

// How many outbox rows to claim per poll -- bounds one iteration's worth of
// sequential forwarding work, the same role CHAIN_FIREHOSE_QUEUE_MAX_SIZE
// played for the old in-memory NOTIFY queue. Rows beyond this per poll are
// simply picked up on the next iteration (the outbox itself is the durable
// backlog now, not an in-memory queue), so there's no drop-oldest behavior
// to replicate here.
export const CHAIN_FIREHOSE_POLL_BATCH_SIZE = 200;

// Idle poll interval -- how long to wait before re-polling after a batch came
// back empty. When a poll DOES claim rows, the loop re-polls immediately
// (no sleep) to drain a backlog quickly rather than waiting out this
// interval between every batch.
export const CHAIN_FIREHOSE_POLL_INTERVAL_MS = 250;

// How long a delivered (or dropped -- see forwardBatch's own comment) row
// stays in the outbox before cleanup deletes it. Generous over any plausible
// relay restart/redeploy window while still bounding table growth (the #5027
// review's own nit: nothing else prunes this table).
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

// Forwards one payload to the hub's ingest endpoint. `fetchImpl` is injected
// so this is testable without a real network call -- the poll loop below is
// the only caller in production. `payload` is the JSON-serialized string
// body, not the parsed object (the caller stringifies chain_firehose_outbox's
// already-parsed JSONB column once, up front).
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
    const result = { ok: response.ok, status: response.status };
    await response.body?.cancel();
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

// Forwards one payload with bounded retry/backoff. Returns true if the
// payload was forwarded successfully, false if it was dropped after
// exhausting CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS -- never throws (a
// forwarding failure must never crash the relay's poll loop).
export async function forwardWithRetry(
  payload,
  config,
  {
    fetchImpl = fetch,
    sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
    onDrop,
  } = {},
) {
  for (
    let attempt = 0;
    attempt < CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const result = await forwardChainFirehoseNotification(
        payload,
        config,
        fetchImpl,
      );
      if (result.ok) return true;
    } catch {
      // network error -- fall through to retry/backoff below
    }
    if (attempt < CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS - 1) {
      await sleepImpl(computeBackoffDelayMs(attempt));
    }
  }
  onDrop?.(payload);
  return false;
}

// Forwards every row in a claimed batch with bounded concurrency (see
// CHAIN_FIREHOSE_FORWARD_CONCURRENCY's own comment for why this isn't
// sequential). `rows` are already claimed (delivered_at stamped) by the
// caller's UPDATE ... RETURNING before this runs -- forwarding failure after
// exhausting retries still counts as "handled" (best-effort, not
// at-least-once, same as the old design), not re-queued.
export async function forwardBatch(rows, config, options = {}) {
  const results = await mapBounded(
    rows,
    CHAIN_FIREHOSE_FORWARD_CONCURRENCY,
    (row) => forwardWithRetry(JSON.stringify(row.payload), config, options),
  );
  const forwarded = results.filter(Boolean).length;
  return { forwarded, dropped: results.length - forwarded };
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
  const config = parseRelayConfig(process.env);
  const sql = postgres(config.databaseUrl);
  let shuttingDown = false;

  const shutdown = async () => {
    shuttingDown = true;
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Claims up to CHAIN_FIREHOSE_POLL_BATCH_SIZE pending rows in one atomic
  // UPDATE ... RETURNING (SKIP LOCKED so a concurrently-running second relay
  // instance -- a brief overlap during a redeploy -- claims disjoint rows
  // instead of racing on the same ones), stamping delivered_at as the claim
  // marker before any HTTP forwarding happens.
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
    if (rows.length === 0) return 0;
    await forwardBatch(rows, config, {
      onDrop: () =>
        console.error(
          `[chain-firehose-relay] dropped a payload after ${CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS} attempts`,
        ),
    });
    return rows.length;
  }

  async function cleanupOnce() {
    const cutoff = new Date(Date.now() - CHAIN_FIREHOSE_OUTBOX_RETENTION_MS);
    await sql`
      DELETE FROM chain_firehose_outbox
      WHERE delivered_at IS NOT NULL AND delivered_at < ${cutoff}`;
  }

  let lastCleanupAt = Date.now();
  console.log(
    `[chain-firehose-relay] polling chain_firehose_outbox every ${CHAIN_FIREHOSE_POLL_INTERVAL_MS}ms, forwarding to ${config.ingestUrl}`,
  );
  while (!shuttingDown) {
    const claimed = await pollOnce();
    if (Date.now() - lastCleanupAt >= CHAIN_FIREHOSE_CLEANUP_INTERVAL_MS) {
      await cleanupOnce();
      lastCleanupAt = Date.now();
    }
    if (claimed === 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, CHAIN_FIREHOSE_POLL_INTERVAL_MS),
      );
    }
    // claimed > 0: loop again immediately to drain a backlog faster than
    // one CHAIN_FIREHOSE_POLL_INTERVAL_MS per batch would.
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[chain-firehose-relay] fatal:", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
