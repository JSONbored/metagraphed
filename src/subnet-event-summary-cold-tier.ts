// One subnet's event-kind summary, read from the lakehouse.
//
// `/api/v1/subnets/{netuid}/event-summary` reported `total_events: 0` for
// EVERY netuid -- 1, 8, 19, 64 all answered zero -- while
// `/subnets/{netuid}/events` served real rows off the same stream. Like the
// sibling feed (#9260, see loadSubnetEventsColdTier), the handler ran
// `tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE) ?? buildSubnetEventSummary([], [], …)`
// and nothing Cloudflare-native ever replaced the deleted Postgres tier.
//
// THE OBVIOUS QUERY IS REJECTED. The natural port is one grouped rollup:
//
//   SELECT event_kind, count(*), count(DISTINCT hotkey), count(DISTINCT coldkey), …
//   FROM chain.account_events WHERE netuid = ? AND observed_at >= ? GROUP BY event_kind
//
// R2 SQL refuses it at this route's own default window:
//
//   40015: scan budget exceeded: scanning too much data for count(DISTINCT),
//   count(DISTINCT) with GROUP BY
//
// Note "with GROUP BY" -- adding the GROUP BY is NOT the fix here, unlike the
// ungrouped cases in the event rollups and the account summary card. Two
// distincts in one grouped scan exceed the budget on their own, and this route
// also offers a 90d window, three times the span that already fails.
//
// So each distinct is DISTRIBUTED into its own nested aggregation: group to the
// (kind, key) pairs first, then count the pairs per kind. `hotkey IS NOT NULL`
// is load-bearing rather than tidy -- `COUNT(DISTINCT col)` ignores NULLs while
// `GROUP BY col` yields a NULL group, so without it every kind whose rows carry
// no hotkey (WeightsSet, and every Balances kind for coldkey) would report one
// phantom participant.
//
// The plain aggregates stay in one read: count(*), the block/time bounds and
// the amount sums contain no distinct, so none of the above applies to them.
import {
  buildSubnetEventSummary,
  SUBNET_EVENT_SUMMARY_WINDOWS,
} from "./account-events.ts";
import { SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT } from "./route-limits.ts";
import { r2SqlQuery, safeBlockNumber } from "./r2-sql.ts";

type Row = Record<string, unknown>;

/** Kept identical to the sibling feed's SELECT list so both hand
 * `formatAccountEvent` the same shape. */
const EVENT_COLUMNS =
  "block_number, event_index, extrinsic_index, event_kind, hotkey, coldkey, " +
  "netuid, uid, amount_tao, alpha_amount, observed_at";

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
  env: Env | null | undefined,
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
    query?: typeof r2SqlQuery;
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
    query(env, distinctPerKind("hotkey", where)),
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
