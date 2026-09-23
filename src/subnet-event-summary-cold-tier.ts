// Subnet event summaries fold complete native account-event indexes, including
// hotkey-or-UID actors and distinct coldkeys. The archived SQL path remains
// available only while the native selection is not yet qualified.
import {
  buildSubnetEventSummary,
  SUBNET_EVENT_SUMMARY_WINDOWS,
} from "./account-events.ts";
import { SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT } from "./route-limits.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";
import type { R2SqlReader } from "./r2-sql.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../generated/lakehouse/types.ts";
import type { R2SqlEnv } from "./r2-sql.ts";
import { loadIndexedSubnetEventSummaryRows } from "./subnet-indexed-aggregates.ts";

type Row = Record<string, unknown>;

/** Kept identical to the sibling feed's SELECT list so both hand
 * `formatAccountEvent` the same shape. */
// The generated tuple, not a retyped copy -- see src/r2-sql-blocks.ts for why.
const EVENT_COLUMNS = ACCOUNT_EVENTS_COLUMNS.join(", ");

/**
 * `count(DISTINCT <column>)` per event_kind, expressed as a nested GROUP BY.
 *
 * The inner query collapses to one row per (event_kind, column) pair and the
 * outer one counts those pairs -- the "distribute the aggregation" form the
 * engine's own rejection message asks for.
 */
function distinctPerKind(column: string, where: string): string {
  return (
    `SELECT event_kind, count(*) AS n FROM (` +
    `SELECT event_kind, ${column} FROM chain.account_events` +
    ` WHERE ${where} AND ${column} IS NOT NULL` +
    ` GROUP BY event_kind, ${column}) GROUP BY event_kind`
  );
}

/**
 * What identifies ONE participant, for the per-kind actor count.
 *
 * NOT `hotkey` alone. WeightsSet is the highest-volume kind on most subnets and
 * the chain event emits [netuid, uid] with NO hotkey, so `hotkey` is NULL on
 * every one of its rows -- counting it reports `hotkey_count: 0` beside a
 * five-figure `event_count`, which is precisely the "measured zero" this reader
 * exists to stop publishing (netuid 64/30d: 9,830 events, 0 setters, against a
 * real 15). The retired Postgres route counted this same hotkey-or-uid
 * identity, citing the same reason, as do the weight-setter leaderboards.
 *
 * `netuid` is fixed by the caller's WHERE, so a bare uid is unambiguous here;
 * the retired query spelled the (netuid, uid) pair only because it was not
 * subnet-scoped. The prefixes keep the two namespaces from colliding, and the
 * CASE yields NULL when a row carries neither -- dropped by the outer filter,
 * matching COUNT(DISTINCT)'s own NULL handling.
 */
const ACTOR_IDENTITY =
  `CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey` +
  ` WHEN uid IS NOT NULL THEN 'uid:' || CAST(uid AS VARCHAR) END`;

/** The actor count per event_kind, distributed exactly like distinctPerKind
 * but over the composite identity above. */
function distinctActorPerKind(where: string): string {
  return (
    `SELECT event_kind, count(*) AS n FROM (` +
    `SELECT event_kind, ${ACTOR_IDENTITY} AS actor FROM chain.account_events` +
    ` WHERE ${where}` +
    ` GROUP BY event_kind, ${ACTOR_IDENTITY})` +
    ` WHERE actor IS NOT NULL GROUP BY event_kind`
  );
}

/** event_kind -> the counted value, for merging a distinct read into the base
 * rollup. A row whose kind is not a usable string is dropped rather than keyed
 * under "undefined". */
function byKind(rows: Row[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of rows) {
    const kind = row?.event_kind;
    if (typeof kind === "string" && kind.length > 0) out.set(kind, row.n);
  }
  return out;
}

/**
 * One subnet's event summary from the lakehouse, already built into the
 * response shape -- or null when the lakehouse cannot answer.
 *
 * An EMPTY result is not a decline. `query` returns null on failure and `[]` on
 * a successful empty scan, so a subnet with genuinely no events in the window
 * publishes a measured zero, the same way the sibling feed publishes an empty
 * page. Declining on empty would make a quiet subnet indistinguishable from a
 * broken tier -- the inverse of the bug this fixes.
 */
export async function loadSubnetEventSummaryColdTier(
  env: R2SqlEnv | null | undefined,
  netuid: number,
  {
    window,
    limit,
    query = r2SqlQuery,
  }: {
    window: string;
    /** Absent/unusable resolves to the route default rather than declining --
     * `parseLimitParam` types its result as `number | undefined`, and a missing
     * `?limit=` must serve the default page, not an empty card. */
    limit?: number | null;
    /** Injectable for tests. */
    query?: R2SqlReader;
  },
): Promise<ReturnType<typeof buildSubnetEventSummary> | null> {
  // An unusable netuid is a decline, not an unfiltered scan of every subnet.
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  // An unusable limit resolves to the route default rather than declining.
  // The positivity check is part of "unusable", not a separate guard: `??`
  // only catches null/undefined, so a literal 0 would sail through it and
  // produce `LIMIT 0` -- a silently empty recent-events page. `parseLimitParam`
  // rejects 0 at the REST edge, but this reader is also called directly by MCP
  // and GraphQL.
  const requested = safeBlockNumber(
    limit ?? SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  );
  const cap =
    requested !== null && requested > 0
      ? requested
      : SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT;

  // The window is validated against the route's own map, not parsed, so an
  // unrecognised label declines instead of silently widening the range. That
  // also bounds the cutoff: every value in the map is a small positive day
  // count, so no further arithmetic guard can fire.
  const days = SUBNET_EVENT_SUMMARY_WINDOWS[window];
  if (!Number.isFinite(days) || days <= 0) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const indexed = await loadIndexedSubnetEventSummaryRows(
    env,
    subnet,
    cutoff,
    cap,
  );
  if (indexed !== undefined)
    return indexed === null
      ? null
      : buildSubnetEventSummary(indexed.kinds, indexed.recent, subnet, {
          window,
          limit: cap,
        });

  // The two key columns are literals below, never caller input -- the only
  // interpolated values are `subnet` and `cutoff`, both already narrowed to
  // integers above. R2 SQL has no bound parameters, so that is the whole
  // injection surface and it is closed by construction rather than by a guard.
  const where = `netuid = ${subnet} AND observed_at >= ${cutoff}`;

  const [baseRows, hotkeyRows, coldkeyRows, recentRows] = await Promise.all([
    query(
      env,
      `SELECT event_kind, count(*) AS event_count,` +
        ` min(block_number) AS first_block, max(block_number) AS last_block,` +
        ` min(observed_at) AS first_observed_at,` +
        ` max(observed_at) AS last_observed_at,` +
        ` sum(amount_tao) AS amount_tao, sum(alpha_amount) AS alpha_amount` +
        ` FROM chain.account_events WHERE ${where} GROUP BY event_kind`,
    ),
    query(env, distinctActorPerKind(where)),
    // Coldkey has no such fallback and needs none: it is the delegating
    // account, absent by nature on the kinds that have no delegator (a
    // WeightsSet has no payer), so a plain distinct over the non-null rows is
    // the answer rather than a gap to fill.
    query(env, distinctPerKind("coldkey", where)),
    query(
      env,
      `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where}` +
        ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
        ` LIMIT ${cap}`,
    ),
  ]);

  // Any half missing is a decline: a summary pairing real counts with a zeroed
  // participant count would publish "9,832 WeightsSet events from 0 hotkeys",
  // which is not a number anyone can act on and reads as measured fact.
  if (!baseRows || !hotkeyRows || !coldkeyRows || !recentRows) return null;

  const hotkeys = byKind(hotkeyRows);
  const coldkeys = byKind(coldkeyRows);
  const kindRows = baseRows.map((row) => ({
    ...row,
    hotkey_count: hotkeys.get(String(row.event_kind)) ?? 0,
    coldkey_count: coldkeys.get(String(row.event_kind)) ?? 0,
  }));

  return buildSubnetEventSummary(kindRows, recentRows, subnet, {
    window,
    limit: cap,
  });
}
