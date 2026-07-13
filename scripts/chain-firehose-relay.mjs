// Box-side relay for the realtime chain-event firehose (#4981, ADR 0015).
//
// A tiny always-on process: LISTEN chain_firehose on the indexer box's own
// Postgres (deploy/postgres/schema.sql's notify_chain_firehose() trigger,
// #4980), and forward each notification to the Cloudflare Durable Object's
// ingest endpoint (workers/chain-firehose-hub.mjs, #4982) over HTTPS.
//
// Deliberately a PURE consumer: it opens its own dedicated Postgres
// connection for LISTEN only, never writes anything, and is never in
// indexer-rs's critical path -- unlike the retired metagraphed-streamer
// (docs/adr/0014, whose synchronous push from the live-follow process into
// a blocking write path starved the same connection servicing the chain-head
// subscription), a stalled or unreachable ingest endpoint here can only ever
// stall THIS process's own best-effort forwarding, never indexer-rs's writes
// or Postgres's durability. Best-effort by design: the firehose has no
// durability guarantee (see docs/realtime-firehose.md) -- a notification
// that can't be forwarded after a bounded number of retries is dropped, not
// queued indefinitely or retried forever.
//
// Deployed the same way the retired streamer was: an Ansible role in
// JSONbored/metagraphed-infra (roles/chain-firehose-relay/) builds
// deploy/chain-firehose-relay.Dockerfile directly on the indexer box,
// COPYing this script in. See that Dockerfile's own header comment.
//
// Run: DATABASE_URL=... CHAIN_FIREHOSE_INGEST_URL=... \
//      CHAIN_FIREHOSE_SYNC_SECRET=... node scripts/chain-firehose-relay.mjs

import postgres from "postgres";

export const CHAIN_FIREHOSE_LISTEN_CHANNEL = "chain_firehose";
export const CHAIN_FIREHOSE_INGEST_TOKEN_HEADER = "x-chain-firehose-sync-token";
export const DEFAULT_CHAIN_FIREHOSE_INGEST_URL =
  "https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest";

// Drop-oldest bound: caps this process's own memory under a sustained ingest
// outage. Generous over any plausible per-block NOTIFY burst (see the
// trigger's own row-vs-statement-level tradeoff note in schema.sql) while
// still bounded.
export const CHAIN_FIREHOSE_QUEUE_MAX_SIZE = 5_000;

// A notification is retried this many times (with backoff) before being
// dropped -- best-effort, not at-least-once (see this module's header).
export const CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS = 3;
export const CHAIN_FIREHOSE_BACKOFF_BASE_MS = 500;
export const CHAIN_FIREHOSE_BACKOFF_MAX_MS = 15_000;
export const CHAIN_FIREHOSE_FORWARD_TIMEOUT_MS = 10_000;

// --- pure, unit-tested logic ----------------------------------------------------

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

// A bounded FIFO queue that drops its OLDEST entry once full, rather than
// growing unboundedly or rejecting the newest arrival -- under a sustained
// ingest outage, the most recent chain state is more useful to a
// newly-reconnecting subscriber than the oldest backlog.
export function createBoundedDropOldestQueue(
  maxSize = CHAIN_FIREHOSE_QUEUE_MAX_SIZE,
) {
  const items = [];
  let dropped = 0;
  return {
    push(item) {
      items.push(item);
      if (items.length > maxSize) {
        items.shift();
        dropped += 1;
      }
    },
    shift() {
      return items.shift();
    },
    get size() {
      return items.length;
    },
    get droppedCount() {
      return dropped;
    },
  };
}

// Forwards one notification payload to the hub's ingest endpoint. `fetchImpl`
// is injected so this is testable without a real network call -- the
// long-running LISTEN/retry loop below is the only caller in production.
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

// Drains one queued payload with bounded retry/backoff. Returns true if the
// payload was forwarded successfully, false if it was dropped after
// exhausting CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS -- never throws (a
// forwarding failure must never crash the relay's LISTEN loop).
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

/* v8 ignore start -- the long-running LISTEN/drain loop needs a real
   Postgres connection and process lifecycle (SIGTERM/SIGINT); every decision
   it makes (config validation, backoff timing, queue bounding, retry count)
   is delegated to the pure functions above and unit-tested directly (see
   tests/chain-firehose-relay.test.mjs). This file is intentionally outside
   vitest.config.mjs's coverage.include, matching every other standalone
   deploy/-tier process in this repo (e.g. deploy/wss-lb, tested via `node
   --test` instead) -- see that config's own comment for the convention. */
async function main() {
  const config = parseRelayConfig(process.env);
  const sql = postgres(config.databaseUrl);
  const queue = createBoundedDropOldestQueue();
  let draining = false;
  let shuttingDown = false;

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.size > 0 && !shuttingDown) {
      const payload = queue.shift();
      await forwardWithRetry(payload, config, {
        onDrop: () =>
          console.error(
            `[chain-firehose-relay] dropped a notification after ${CHAIN_FIREHOSE_MAX_FORWARD_ATTEMPTS} attempts`,
          ),
      });
    }
    draining = false;
  }

  await sql.listen(CHAIN_FIREHOSE_LISTEN_CHANNEL, (payload) => {
    queue.push(payload);
    void drain();
  });
  console.log(
    `[chain-firehose-relay] listening on ${CHAIN_FIREHOSE_LISTEN_CHANNEL}, forwarding to ${config.ingestUrl}`,
  );

  const shutdown = async () => {
    // Doesn't wait for an in-flight forwardWithRetry to finish -- a
    // notification mid-retry at shutdown is dropped, same as any other
    // best-effort drop this relay makes (see this file's header comment).
    shuttingDown = true;
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[chain-firehose-relay] fatal:", error);
    process.exit(1);
  });
}
/* v8 ignore stop */
