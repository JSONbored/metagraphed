// Subnet event summaries fold complete native account-event indexes, including
// hotkey-or-UID actors and distinct coldkeys. Incomplete coverage declines.
import {
  buildSubnetEventSummary,
  SUBNET_EVENT_SUMMARY_WINDOWS,
} from "./account-events.ts";
import { SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT } from "./route-limits.ts";
import { safeBlockNumber } from "./history-readers.ts";
import type { HistoryReadEnv } from "./history-readers.ts";
import { loadIndexedSubnetEventSummaryRows } from "./subnet-indexed-aggregates.ts";

export async function loadSubnetEventSummaryColdTier(
  env: HistoryReadEnv | null | undefined,
  netuid: number,
  {
    window,
    limit,
  }: {
    window: string;
    /** Absent/unusable resolves to the route default rather than declining --
     * `parseLimitParam` types its result as `number | undefined`, and a missing
     * `?limit=` must serve the default page, not an empty card. */
    limit?: number | null;
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
  return indexed == null
    ? null
    : buildSubnetEventSummary(indexed.kinds, indexed.recent, subnet, {
        window,
        limit: cap,
      });
}
