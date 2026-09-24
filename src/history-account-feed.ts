import {
  checkFeedNode,
  feedInverse as inverse,
  feedOrder as order,
  iteratePackedFeed,
} from "./history-feed-tree.ts";
import {
  HistoryAccountFeedSchema,
  type HistoryAccountFeed,
  type HistoryFeedNode,
} from "../schemas-src/artifacts/history-account-feed.ts";
import { AccountEventsRowSchema } from "../schemas-src/lakehouse.ts";
import {
  ACCOUNT_EVENTS_COLUMNS,
  type AccountEventsRow,
} from "../generated/lakehouse/types.ts";
import {
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

export interface AccountFeedSelector {
  side: "hotkey" | "coldkey" | "all";
  account: string;
  counterparty?: string;
  kind?: string | null;
  netuid?: number | null;
  blockStart?: number;
  blockEnd?: number;
  observedStart?: number;
  observedEnd?: number;
  cursor?: [number, number, number] | null;
}
export interface IndexedAccountFeedEntry {
  token: string;
  row: AccountEventsRow;
}
const rowSchema = AccountEventsRowSchema.required();
const rootKey = (feed: HistoryAccountFeed) =>
  `metagraph/indexed-history/v1/${feed.network}/account_events/generations/${feed.generation}/accounts/v1/`;

/** The producer's final receipt proves every physical source row participated. */
export function validateAccountFeed(
  input: unknown,
  selected: HistoryAccountFeed["selection"],
): HistoryAccountFeed {
  const feed = HistoryAccountFeedSchema.parse(input);
  const base = rootKey(feed),
    selection = feed.selection;
  if (
    feed.network !== selected.network ||
    feed.generation !== selected.generation ||
    selection.network !== feed.network ||
    selection.generation !== feed.generation ||
    selection.firstBlock !== selected.firstBlock ||
    selection.lastBlock !== selected.lastBlock ||
    selection.firstBlock > selection.lastBlock ||
    selected.table !== "account_events" ||
    selection.blockManifest.key !== selected.blockManifest.key ||
    selection.blockManifest.etag !== selected.blockManifest.etag ||
    selection.blockManifest.bytes !== selected.blockManifest.bytes ||
    selection.blockManifest.key !==
      base.replace(/accounts\/v1\/$/, "block-manifest.json") ||
    feed.plan.key !== `${base}plan.json` ||
    feed.plan.bytes > 32 * 1024 * 1024 ||
    feed.entries < feed.rows ||
    feed.entries > feed.rows * 13 ||
    feed.entries !== (feed.root?.rows ?? 0)
  )
    throw new Error("Account feed generation identity or census mismatch");
  if (feed.root) checkFeedNode(feed.root, { ...feed, base });
  return feed;
}

async function queryKey(selector: AccountFeedSelector): Promise<string> {
  if (
    !/^[\x20-\x7e]+$/.test(selector.account) ||
    !["hotkey", "coldkey", "all"].includes(selector.side) ||
    (selector.side === "all" && selector.account !== "*") ||
    (selector.kind != null && !/^[\x20-\x7e]+$/.test(selector.kind))
  )
    throw new Error("Invalid account feed selector");
  if (selector.netuid !== undefined && selector.netuid !== null)
    inverse(selector.netuid, 0xffffffff, 8);
  const peer = selector.counterparty;
  if (
    peer !== undefined &&
    (!/^[\x20-\x7e]+$/.test(peer) ||
      peer.includes(":") ||
      selector.account.includes(":") ||
      selector.side === "all" ||
      selector.kind !== "Transfer" ||
      selector.netuid != null)
  )
    throw new Error("Invalid account feed relationship selector");
  const side = peer === undefined ? selector.side : "pair";
  const account =
    peer === undefined
      ? selector.account
      : selector.side === "hotkey"
        ? `${selector.account}:${peer}`
        : `${peer}:${selector.account}`;
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      side,
      account,
      selector.kind ?? null,
      selector.netuid ?? null,
    ]),
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Account-specific row and selector proofs share the packed tree traversal. */
export async function* iterateAccountFeed(
  source: ParquetRangeSource,
  feed: HistoryAccountFeed,
  selector: AccountFeedSelector,
  budget: ParquetReadBudget,
  readPage?: (
    node: Extract<HistoryFeedNode, { height: 0 }>,
  ) => Promise<ArrayBuffer>,
): AsyncGenerator<IndexedAccountFeedEntry> {
  const key = await queryKey(selector);
  const decode = (values: unknown, token: string): AccountEventsRow => {
    if (
      !Array.isArray(values) ||
      values.length !== ACCOUNT_EVENTS_COLUMNS.length
    )
      throw new Error("Invalid account feed row width");
    const row = rowSchema.parse(
      Object.fromEntries(
        ACCOUNT_EVENTS_COLUMNS.map((name, i) => [name, values[i]]),
      ),
    );
    if (
      row.observed_at === null ||
      row.block_number === null ||
      row.event_index === null ||
      order(row.observed_at, row.block_number, row.event_index) !==
        token.slice(64, 94)
    )
      throw new Error("Account feed ordering differs from its row");
    return row;
  };
  for await (const entry of iteratePackedFeed(
    source,
    { ...feed, base: rootKey(feed) },
    selector,
    budget,
    key,
    decode,
    readPage,
  )) {
    const { row } = entry;
    if (
      (selector.side !== "all" && row[selector.side] !== selector.account) ||
      (selector.kind != null && row.event_kind !== selector.kind) ||
      (selector.netuid != null && row.netuid !== selector.netuid) ||
      (selector.counterparty !== undefined &&
        (selector.side === "hotkey" ? row.coldkey : row.hotkey) !==
          selector.counterparty)
    )
      throw new Error("Account feed row differs from its selector");
    yield entry;
  }
}

/** Equal physical captures have the same complete sort suffix and are adjacent
 * in this merge. Keep only that suffix, rather than a lifetime-sized seen set. */
export async function* mergeAccountFeedEntries(
  streams: AsyncGenerator<IndexedAccountFeedEntry>[],
): AsyncGenerator<AccountEventsRow> {
  // Four ordinary generations plus one closed runtime correction, with at
  // most four selectors, and one disjoint hot tail share the existing budget.
  if (streams.length > 21)
    throw new Error("Account feed page exceeds its budget");
  let previous: string | undefined;
  try {
    const heads = await Promise.all(streams.map((stream) => stream.next()));
    while (true) {
      let index = -1;
      heads.forEach((head, i) => {
        if (
          !head.done &&
          (index < 0 ||
            head.value.token.slice(64) < heads[index].value!.token.slice(64))
        )
          index = i;
      });
      if (index < 0) break;
      const entry = heads[index].value!;
      const identity = entry.token.slice(64);
      if (identity !== previous) {
        previous = identity;
        yield entry.row;
      }
      heads[index] = await streams[index].next();
    }
  } finally {
    await Promise.all(streams.map((stream) => stream.return(undefined)));
  }
}

/** OR unions deduplicate physical captures, preserving separate retained rows. */
export async function mergeAccountFeedPage(
  streams: AsyncGenerator<IndexedAccountFeedEntry>[],
  limit: number,
  offset = 0,
): Promise<AccountEventsRow[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 5001 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 5000 ||
    streams.length > 11
  )
    throw new Error("Account feed page exceeds its budget");
  const rows: AccountEventsRow[] = [];
  for await (const row of mergeAccountFeedEntries(streams)) {
    rows.push(row);
    if (rows.length === limit + offset) break;
  }
  return rows.slice(offset);
}
