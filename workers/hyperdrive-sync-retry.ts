// METAGRAPHED-7, second recurrence (2026-07-24): the read dispatcher's fresh-client
// retry loop (workers/data-api.ts's route dispatcher) eliminated the read-path
// CONNECTION_CLOSED class, but every internal sync route still lost its whole mirror
// write to a single dropped socket -- the 09:00Z origin blip dropped health-checks-sync,
// health-uptime-rollup-sync, and health-status-live in one burst while every read route
// rode out the same blip on retries. The original "never retry the write/sync routes"
// stance over-generalized: it is right for non-transactional multi-statement writes,
// but every sync route funnels its batch through ONE atomic sql.begin() -- a failure
// rolls the whole transaction back, so nothing can have partially applied and a retry
// re-runs the identical idempotent batch; it cannot double-write. Single-statement
// writes stay excluded unless the statement itself is idempotent (rpc-usage-prune's
// cutoff DELETE is; rpc-usage-event's plain INSERT is not -- an ambiguous commit plus
// a retry would double-count, so it keeps the no-retry stance at its call site).
//
// Shared between workers/data-api.ts and workers/registry-sync-api.ts -- the same
// neutral-module reasoning as workers/postgres-tier.ts.
import postgres from "postgres";

// Retry only postgres.js's own connection-level failures -- a dropped socket, a torn-down
// pool entry, or a connect that never completed. Anything else (constraint violations,
// statement timeouts, syntax errors) is deterministic and must surface immediately.
export const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
]);
// A single retry (the original METAGRAPHED-7 fix) regressed: under sustained load,
// Hyperdrive can recycle the retry's own freshly created connection too, so the retry
// itself hits the same error class and the request still fails. 2 retries (3 total
// attempts) gives a second freshly created client a chance before giving up.
export const MAX_CONNECTION_RETRY_ATTEMPTS = 2;

// The sync routes' standard Hyperdrive client options (Cloudflare's documented
// postgres.js settings for Workers: bounded concurrency, no prepared-statement cache
// dependence, no type-fetch round-trip).
const SYNC_HYPERDRIVE_OPTIONS = {
  max: 5,
  prepare: false,
  fetch_types: false,
};

/** Run one atomic sync transaction with the read dispatcher's fresh-client retry
 *  semantics: each attempt gets a brand-new client, because the dead socket lives in
 *  the previous client's pool -- reusing it would hand the retry the same corpse. */
export async function syncBeginWithConnectionRetry<T>(
  env: { HYPERDRIVE: { connectionString: string } },
  txFn: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const sql = postgres(
      env.HYPERDRIVE.connectionString,
      SYNC_HYPERDRIVE_OPTIONS,
    );
    try {
      return (await sql.begin(txFn)) as T;
    } catch (err) {
      if (
        attempt >= MAX_CONNECTION_RETRY_ATTEMPTS ||
        !RETRYABLE_CONNECTION_ERROR_CODES.has(
          (err as { code?: string } | null)?.code as string,
        )
      )
        throw err;
    }
    // No sql.end() on the failed client: Hyperdrive cleans up the connection when the
    // request/invocation ends, the same documented convention every call site follows.
  }
}
