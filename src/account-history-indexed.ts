import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { loadIndexedAccountFeedAggregate } from "./indexed-account-feeds.ts";
import type { AccountFeedSelector } from "./history-account-feed.ts";

/** Finish every selected UTC day before sorting its subnet cells. This keeps
 * event counts and kinds complete when a page ends inside a busy day. */
export function loadIndexedAccountHistoryRows(
  env: unknown,
  account: string,
  bounds: Pick<AccountFeedSelector, "netuid" | "observedStart" | "observedEnd">,
  need: number,
): Promise<Record<string, unknown>[] | null | undefined> {
  return loadIndexedAccountFeedAggregate(
    env,
    [{ side: "hotkey", account, ...bounds }],
    (rows) => foldAccountHistoryRows(rows, need),
  );
}

export async function foldAccountHistoryRows(
  rows: AsyncIterable<AccountEventsRow>,
  need: number,
): Promise<Record<string, unknown>[]> {
  if (!Number.isSafeInteger(need) || need < 1 || need > 10000)
    throw new Error("Account history page exceeds budget");
  const groups = new Map<
    string,
    {
      day: string;
      netuid: number;
      event_count: number;
      first_block: number;
      last_block: number;
      kinds: Set<string>;
    }
  >();
  let previousDay: string | undefined;
  for await (const row of rows) {
    if (row.netuid === null) continue;
    const day = new Date(row.observed_at!).toISOString().slice(0, 10);
    if (day !== previousDay && groups.size >= need) break;
    previousDay = day;
    const key = `${day}|${row.netuid}`;
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= 20000)
        throw new Error("Account history group budget exceeded");
      group = {
        day,
        netuid: row.netuid,
        event_count: 0,
        first_block: row.block_number!,
        last_block: row.block_number!,
        kinds: new Set(),
      };
      groups.set(key, group);
    }
    group.event_count++;
    group.first_block = Math.min(group.first_block, row.block_number!);
    group.last_block = Math.max(group.last_block, row.block_number!);
    if (row.event_kind) group.kinds.add(row.event_kind);
  }
  return [...groups.values()]
    .sort((a, b) => b.day.localeCompare(a.day) || b.netuid - a.netuid)
    .slice(0, need)
    .map(({ kinds, ...row }) => ({
      ...row,
      event_kinds: [...kinds].sort().join(","),
    }));
}
