// Frozen pre-retirement query oracle from 8e2cdd9b. This test-only code
// runs against SQLite, independently of native tree selection and folding.
import {
  buildSubnetEventSummary,
  SUBNET_EVENT_SUMMARY_WINDOWS,
} from "../../src/account-events.ts";
import { SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT } from "../../src/route-limits.ts";
import { safeBlockNumber } from "../../src/history-readers.ts";
import type { HistoricalQueryReader } from "../../src/history-readers.ts";
import { ACCOUNT_EVENTS_COLUMNS } from "../../generated/lakehouse/types.ts";
import type { HistoryReadEnv } from "../../src/history-readers.ts";

type Row = Record<string, unknown>;
const EVENT_COLUMNS = ACCOUNT_EVENTS_COLUMNS.join(", ");

function distinctPerKind(column: string, where: string): string {
  return (
    `SELECT event_kind, count(*) AS n FROM (` +
    `SELECT event_kind, ${column} FROM chain.account_events` +
    ` WHERE ${where} AND ${column} IS NOT NULL` +
    ` GROUP BY event_kind, ${column}) GROUP BY event_kind`
  );
}

const ACTOR_IDENTITY =
  `CASE WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey` +
  ` WHEN uid IS NOT NULL THEN 'uid:' || CAST(uid AS VARCHAR) END`;

function distinctActorPerKind(where: string): string {
  return (
    `SELECT event_kind, count(*) AS n FROM (` +
    `SELECT event_kind, ${ACTOR_IDENTITY} AS actor FROM chain.account_events` +
    ` WHERE ${where}` +
    ` GROUP BY event_kind, ${ACTOR_IDENTITY})` +
    ` WHERE actor IS NOT NULL GROUP BY event_kind`
  );
}

function byKind(rows: Row[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const row of rows) {
    const kind = row?.event_kind;
    if (typeof kind === "string" && kind.length > 0) out.set(kind, row.n);
  }
  return out;
}

export async function loadSubnetEventSummaryColdTier(
  env: HistoryReadEnv | null | undefined,
  netuid: number,
  {
    window,
    limit,
    query,
  }: {
    window: string;

    limit?: number | null;

    query: HistoricalQueryReader;
  },
): Promise<ReturnType<typeof buildSubnetEventSummary> | null> {
  const subnet = safeBlockNumber(netuid);
  if (subnet === null) return null;
  const requested = safeBlockNumber(
    limit ?? SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT,
  );
  const cap =
    requested !== null && requested > 0
      ? requested
      : SUBNET_EVENT_SUMMARY_RECENT_LIMIT_DEFAULT;
  const days = SUBNET_EVENT_SUMMARY_WINDOWS[window];
  if (!Number.isFinite(days) || days <= 0) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
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
    query(env, distinctPerKind("coldkey", where)),
    query(
      env,
      `SELECT ${EVENT_COLUMNS} FROM chain.account_events WHERE ${where}` +
        ` ORDER BY observed_at DESC, block_number DESC, event_index DESC` +
        ` LIMIT ${cap}`,
    ),
  ]);
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
