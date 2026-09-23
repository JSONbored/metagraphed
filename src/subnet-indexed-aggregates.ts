import type { AccountEventsRow } from "../generated/lakehouse/types.ts";
import { loadIndexedAccountFeedAggregate } from "./indexed-account-feeds.ts";
import {
  MAX_CANDLES,
  STAKE_ADDED_KIND,
  STAKE_REMOVED_KIND,
} from "./subnet-ohlc.ts";

type Row = Record<string, unknown>;

/** Inputs arrive in descending observed/block/event order. The first valid
 * trade is the close; each older trade replaces the open. Physical captures
 * remain distinct, while overlapping selectors are deduplicated upstream. */
export function loadIndexedSubnetOhlcRows(
  env: unknown,
  netuid: number,
  cutoff: number,
  intervalMs: number,
): Promise<Row[] | null | undefined> {
  return loadIndexedAccountFeedAggregate(
    env,
    [STAKE_ADDED_KIND, STAKE_REMOVED_KIND].map((kind) => ({
      side: "all",
      account: "*",
      kind,
      netuid,
      observedStart: cutoff,
    })),
    (rows) => foldSubnetOhlcRows(rows, intervalMs),
  );
}

export async function foldSubnetOhlcRows(
  rows: AsyncIterable<AccountEventsRow>,
  intervalMs: number,
): Promise<Row[]> {
  const buckets = new Map<number, Record<string, number>>();
  for await (const row of rows) {
    if (
      row.alpha_amount === null ||
      row.alpha_amount <= 0 ||
      row.amount_tao === null
    )
      continue;
    const stamp = row.observed_at!;
    const key = Math.floor(stamp / intervalMs) * intervalMs;
    const price = row.amount_tao / row.alpha_amount;
    let bucket = buckets.get(key);
    if (!bucket) {
      // The extra complete bucket preserves the existing truncation signal.
      if (buckets.size === MAX_CANDLES + 1) break;
      bucket = {
        bucket_start: key,
        open_price: price,
        close_price: price,
        high_price: price,
        low_price: price,
        volume_alpha: 0,
        volume_tao: 0,
        event_count: 0,
        last_observed: stamp,
      };
      buckets.set(key, bucket);
    }
    bucket.open_price = price;
    bucket.high_price = Math.max(bucket.high_price, price);
    bucket.low_price = Math.min(bucket.low_price, price);
    bucket.volume_alpha += row.alpha_amount;
    bucket.volume_tao += row.amount_tao;
    bucket.event_count++;
    if (!Object.values(bucket).every(Number.isFinite))
      throw new Error("Subnet candle exceeds numeric range");
  }
  return [...buckets.values()];
}

/** Match SQL's nullable SUM and hotkey-or-UID participant identities. Only
 * aggregate cells, distinct identities, and the requested recent page persist. */
export function loadIndexedSubnetEventSummaryRows(
  env: unknown,
  netuid: number,
  cutoff: number,
  limit: number,
): Promise<{ kinds: Row[]; recent: AccountEventsRow[] } | null | undefined> {
  return loadIndexedAccountFeedAggregate(
    env,
    [{ side: "all", account: "*", netuid, observedStart: cutoff }],
    (rows) => foldSubnetEventSummaryRows(rows, limit),
  );
}

export async function foldSubnetEventSummaryRows(
  rows: AsyncIterable<AccountEventsRow>,
  limit: number,
): Promise<{ kinds: Row[]; recent: AccountEventsRow[] }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new Error("Subnet summary page exceeds budget");
  let identities = 0;
  const addIdentity = (set: Set<string>, value: string) => {
    if (!set.has(value)) {
      if (++identities > 131072)
        throw new Error("Subnet participant budget exceeded");
      set.add(value);
    }
  };
  const groups = new Map<
    string | null,
    {
      row: Row;
      hotkeys: Set<string>;
      coldkeys: Set<string>;
    }
  >();
  const recent: AccountEventsRow[] = [];
  for await (const event of rows) {
    if (recent.length < limit) recent.push(event);
    let group = groups.get(event.event_kind);
    if (!group) {
      if (groups.size >= 4096) throw new Error("Subnet kind budget exceeded");
      group = {
        row: {
          event_kind: event.event_kind,
          event_count: 0,
          first_block: event.block_number,
          last_block: event.block_number,
          first_observed_at: event.observed_at,
          last_observed_at: event.observed_at,
          amount_tao: null,
          alpha_amount: null,
        },
        hotkeys: new Set(),
        coldkeys: new Set(),
      };
      groups.set(event.event_kind, group);
    }
    const row = group.row;
    row.event_count = Number(row.event_count) + 1;
    row.first_block = Math.min(Number(row.first_block), event.block_number!);
    row.last_block = Math.max(Number(row.last_block), event.block_number!);
    row.first_observed_at = Math.min(
      Number(row.first_observed_at),
      event.observed_at!,
    );
    row.last_observed_at = Math.max(
      Number(row.last_observed_at),
      event.observed_at!,
    );
    for (const name of ["amount_tao", "alpha_amount"] as const) {
      if (event[name] !== null) {
        row[name] = Number(row[name]) + event[name];
        if (!Number.isFinite(row[name]))
          throw new Error("Subnet summary exceeds numeric range");
      }
    }
    if (event.hotkey !== null && event.hotkey !== "")
      addIdentity(group.hotkeys, `hotkey:${event.hotkey}`);
    else if (event.uid !== null) addIdentity(group.hotkeys, `uid:${event.uid}`);
    if (event.coldkey !== null) addIdentity(group.coldkeys, event.coldkey);
  }
  return {
    kinds: [...groups.values()].map(({ row, hotkeys, coldkeys }) => ({
      ...row,
      hotkey_count: hotkeys.size,
      coldkey_count: coldkeys.size,
    })),
    recent,
  };
}
