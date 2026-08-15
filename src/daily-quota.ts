// Per-account daily quota accounting (#8608).
//
// Counters live in `api_quota_daily`, now a store table (tests/fixtures/sqlite-schema), reached over
// the DATA_API service binding --
// the same path workers/api.ts's recordApiKeyUsage already uses on every keyed
// request. See the schema comment for why that beat a Durable Object and Redis.
//
// This module is deliberately storage-free: it holds the day arithmetic and the
// spend DECISION as pure functions, so the accounting is unit-testable without
// a database, and workers/data-api.ts's handler is left as thin SQL plumbing.
// `applyQuotaSpend` is also the specification the SQL statement implements --
// the two agree on the reject-spends-nothing rule, and the tests pin both.

/** UTC day key. Quotas reset at 00:00 UTC, stated in the 429 headers. */
import type { QuotaSpendResponse } from "../schemas-src/internal-wire.ts";

export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Milliseconds until the next UTC midnight -- the real reset instant. */
export function msUntilUtcMidnight(nowMs: number): number {
  const at = new Date(nowMs);
  const next = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate() + 1,
  );
  return next - nowMs;
}

/** The reset instant as an ISO string, for `x-ratelimit-reset`. */
export function quotaResetAt(nowMs: number): string {
  return new Date(nowMs + msUntilUtcMidnight(nowMs)).toISOString();
}

/**
 * What a spend decides, ALIASED from the schema that carries it over the wire.
 *
 * This was a hand-written interface restating `QuotaSpendResponseSchema` field
 * for field, which `validate:type-duplicates` correctly refused -- and it is
 * the same defect the rest of this change is about. The producer and the
 * consumer's parser must not be able to disagree about a shape whose four
 * numbers land in `x-ratelimit-*` headers.
 *
 * Field docs live on the schema now, where the OpenAPI surface reads them.
 */
export type QuotaSpendResult = QuotaSpendResponse;

/**
 * Decide a spend of `cost` against `limit` given `used` units already spent.
 *
 * A request that would exceed the limit is rejected and spends NOTHING: a
 * caller who trips the quota with one expensive call must not also have their
 * remaining allowance drained by the attempt, or a single oversized request
 * could zero an account's day. The SQL in workers/data-api.ts enforces the
 * same rule atomically -- its `WHERE ... <= limit` guard on the upsert is this
 * function's `used + cost > limit` branch, expressed as a conflict predicate.
 */
export function applyQuotaSpend(
  used: number,
  cost: number,
  limit: number,
  nowMs: number,
): QuotaSpendResult {
  const resetAt = quotaResetAt(nowMs);
  if (used + cost > limit) {
    return {
      allowed: false,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      resetAt,
    };
  }
  const nextUsed = used + cost;
  return {
    allowed: true,
    used: nextUsed,
    limit,
    remaining: Math.max(0, limit - nextUsed),
    resetAt,
  };
}
