// The ONE composer for /api/v1/subnets/{netuid}/events. REST, MCP and GraphQL
// all reach the payload through this module and none of them decides the tier
// order itself.
//
// WHY A COMPOSER AND NOT THREE CASCADES. #9212 added the lakehouse leg to the
// REST handler alone. account_events was never registered on the Postgres tier
// and METAGRAPH_ACCOUNT_EVENTS_SOURCE is retired, so tryPostgresTier declines
// unconditionally and the other two surfaces fell straight to the empty
// builder: GET /api/v1/subnets/1/events served real rows off
// chain.account_events (441,963,747 rows, genesis to head) while
// get_subnet_events and GraphQL's subnet_events both reported event_count 0 for
// the same netuid in the same second -- with no error and no degraded marker.
//
// Same shape src/subnet-ownership-answer.ts and src/rpc-usage-answer.ts already
// fixed for their routes; tests/subnet-ownership-surface-parity.test.ts states
// the rule they established -- a surface may not own the cascade, because
// "which store answers, and what an absence means" is one decision, not three.
//
// THE TIER PROBE STAYS WITH THE SURFACE. tryPostgresTier needs a Request and
// each surface has a different one (REST forwards the caller's, MCP and GraphQL
// synthesize theirs), so the surface probes and hands the RESULT here. This
// module owns everything after it -- the part that drifted.
//
// ORDER IS LOAD-BEARING: the cold read is awaited only after the tier declines,
// because it scans the largest table in the lakehouse.

import { loadSubnetEventsColdTier } from "./events-cold-tier.ts";
import { buildSubnetEvents } from "./account-events.ts";

type Row = Record<string, unknown>;

export interface AnswerSubnetEventsQuery {
  limit: number;
  offset: number;
  cursor?: unknown;
  kind?: unknown;
  blockStart?: unknown;
  blockEnd?: unknown;
}

export interface AnswerSubnetEventsOptions {
  coldTier?: typeof loadSubnetEventsColdTier;
}

/**
 * One subnet's chain-event page from whichever store can answer.
 *
 * `tierResult` is the surface's own tryPostgresTier outcome: a payload when the
 * tier answered, null when it declined or is retired.
 *
 * Never returns null -- the schema-stable empty feed is the documented floor
 * once every store has declined, applied HERE so all three surfaces reach it by
 * the same route rather than each inventing it.
 */
export async function answerSubnetEvents(
  env: unknown,
  netuid: number,
  tierResult: Row | null | undefined,
  query: AnswerSubnetEventsQuery,
  { coldTier = loadSubnetEventsColdTier }: AnswerSubnetEventsOptions = {},
): Promise<Row> {
  return (
    tierResult ??
    ((await coldTier(env as never, netuid, {
      limit: query.limit,
      offset: query.offset,
      cursor: query.cursor ?? null,
      kind: query.kind ?? null,
      blockStart: query.blockStart ?? null,
      blockEnd: query.blockEnd ?? null,
    } as never)) as Row | null) ??
    (buildSubnetEvents([], netuid, {
      limit: query.limit,
      offset: query.offset,
      nextCursor: null,
    }) as unknown as Row)
  );
}
