import {
  HistoryAccountFeedSchema,
  HistoryFeedDirectorySchema,
  type HistoryAccountFeed,
  type HistoryFeedNode,
} from "../schemas-src/artifacts/history-account-feed.ts";
import { AccountEventsRowSchema } from "../schemas-src/lakehouse.ts";
import {
  ACCOUNT_EVENTS_COLUMNS,
  type AccountEventsRow,
} from "../generated/lakehouse/types.ts";
import {
  boundedParquetBuffer,
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
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const rowSchema = AccountEventsRowSchema.required();
const suffix =
  /^(?:directory\/[0-9a-f]{64}\.json|(?:(?:stages|merges)\/[0-9a-f]{64}\/)?(?:[0-9a-f]\/)?(?:nodes\/[0-9a-f]{64}\.json|packs\/[0-9a-f]{64}\.bin))$/;
const rootKey = (feed: HistoryAccountFeed) =>
  `metagraph/indexed-history/v1/${feed.network}/account_events/generations/${feed.generation}/accounts/v1/`;

function checkNode(node: HistoryFeedNode, feed: HistoryAccountFeed): void {
  const base = rootKey(feed);
  if (
    node.first > node.last ||
    node.minBlock > node.maxBlock ||
    node.minBlock < feed.selection.firstBlock ||
    node.maxBlock > feed.selection.lastBlock ||
    !node.object.key.startsWith(base) ||
    !suffix.test(node.object.key.slice(base.length)) ||
    ("offset" in node
      ? node.rows > 256 ||
        node.offset + node.length > node.object.bytes ||
        node.object.bytes > 16 * 1024 * 1024 ||
        !node.object.key.endsWith(".bin")
      : node.object.bytes > 128 * 1024 || !node.object.key.endsWith(".json"))
  )
    throw new Error("Account feed node scope or bounds mismatch");
}

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
  if (feed.root) checkNode(feed.root, feed);
  return feed;
}

function inverse(value: number, maximum: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("Invalid account feed ordering integer");
  return (maximum - value).toString(16).padStart(width, "0");
}

function order(stamp: number, block: number, event: number): string {
  return (
    inverse(stamp, Number.MAX_SAFE_INTEGER, 14) +
    inverse(block, 0xffffffff, 8) +
    inverse(event, 0xffffffff, 8)
  );
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

async function inflate(
  raw: ArrayBuffer,
  size: number,
  budget: ParquetReadBudget,
): Promise<Uint8Array> {
  if (budget.decodedBytes + size > budget.maxBytes * 4)
    throw new Error("Account feed decoded byte budget exceeded");
  budget.decodedBytes += size;
  const reader = new Blob([raw])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const output = new Uint8Array(size);
  let offset = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (offset + next.value.length > size)
        throw new Error("Account feed decoded size changed");
      output.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== size) throw new Error("Truncated account feed page");
    return output;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Traversal validates the complete directory/page before yielding any of it. */
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
  const after = selector.cursor ? order(...selector.cursor) : null;
  const cursorLower =
    key + (after === null ? "0".repeat(102) : after + "f".repeat(72));
  const timeLower =
    key +
    inverse(
      selector.observedEnd ?? Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      14,
    ) +
    "0".repeat(88);
  const lower = cursorLower > timeLower ? cursorLower : timeLower;
  const upper =
    key +
    inverse(selector.observedStart ?? 0, Number.MAX_SAFE_INTEGER, 14) +
    "f".repeat(88);
  const firstBlock = selector.blockStart ?? feed.selection.firstBlock;
  const lastBlock = selector.blockEnd ?? feed.selection.lastBlock;
  inverse(firstBlock, 0xffffffff, 8);
  inverse(lastBlock, 0xffffffff, 8);

  async function* walk(
    node: HistoryFeedNode,
  ): AsyncGenerator<IndexedAccountFeedEntry> {
    checkNode(node, feed);
    if (
      node.last < lower ||
      node.first > upper ||
      node.maxBlock < firstBlock ||
      node.minBlock > lastBlock
    )
      return;
    const file = boundedParquetBuffer(source, node.object, budget);
    if (!("offset" in node)) {
      const directory = HistoryFeedDirectorySchema.parse(
        JSON.parse(text.decode(await file.slice(0, node.object.bytes))),
      );
      const children = directory.children;
      if (
        children[0].first !== node.first ||
        children.at(-1)!.last !== node.last ||
        children.reduce((sum, child) => sum + child.rows, 0) !== node.rows ||
        Math.max(...children.map((c) => c.height)) + 1 !== node.height ||
        Math.min(...children.map((c) => c.minBlock)) !== node.minBlock ||
        Math.max(...children.map((c) => c.maxBlock)) !== node.maxBlock ||
        children.some(
          (child, i) => i > 0 && children[i - 1].last >= child.first,
        )
      )
        throw new Error("Account feed directory census or ordering mismatch");
      children.forEach((child) => checkNode(child, feed));
      for (const child of children) yield* walk(child);
      return;
    }
    const raw = readPage
      ? await readPage(node)
      : await file.slice(node.offset, node.offset + node.length);
    const decoded = text.decode(await inflate(raw, node.decodedBytes, budget));
    if (!decoded.endsWith("\n"))
      throw new Error("Truncated account feed record");
    const lines = decoded.slice(0, -1).split("\n");
    const entries = lines.map((line) => {
      const token = line.slice(0, 166);
      if (!/^[0-9a-f]{166}$/.test(token) || line[166] !== "\t")
        throw new Error("Invalid account feed record token");
      const values: unknown = JSON.parse(line.slice(167));
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
      return { token, row };
    });
    if (
      entries.length !== node.rows ||
      entries[0].token !== node.first ||
      entries.at(-1)!.token !== node.last ||
      Math.min(...entries.map((e) => e.row.block_number!)) !== node.minBlock ||
      Math.max(...entries.map((e) => e.row.block_number!)) !== node.maxBlock ||
      entries.some((entry, i) => i > 0 && entries[i - 1].token >= entry.token)
    )
      throw new Error("Account feed page bounds or census mismatch");
    for (const entry of entries) {
      if (entry.token.slice(0, 64) !== key) continue;
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
      if (
        row.block_number! >= firstBlock &&
        row.block_number! <= lastBlock &&
        row.observed_at! >= (selector.observedStart ?? 0) &&
        row.observed_at! <= (selector.observedEnd ?? Number.MAX_SAFE_INTEGER) &&
        (after === null || entry.token.slice(64, 94) > after)
      )
        yield entry;
    }
  }
  if (feed.root && firstBlock <= lastBlock) yield* walk(feed.root);
}

/** Equal physical captures have the same complete sort suffix and are adjacent
 * in this merge. Keep only that suffix, rather than a lifetime-sized seen set. */
export async function* mergeAccountFeedEntries(
  streams: AsyncGenerator<IndexedAccountFeedEntry>[],
): AsyncGenerator<AccountEventsRow> {
  if (streams.length > 16)
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
    streams.length > 8
  )
    throw new Error("Account feed page exceeds its budget");
  const rows: AccountEventsRow[] = [];
  for await (const row of mergeAccountFeedEntries(streams)) {
    rows.push(row);
    if (rows.length === limit + offset) break;
  }
  return rows.slice(offset);
}
