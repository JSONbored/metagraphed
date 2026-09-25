import {
  HistoryFeedDirectorySchema,
  type HistoryFeedNode,
} from "../schemas-src/artifacts/history-account-feed.ts";
import {
  boundedParquetBuffer,
  type ParquetRangeSource,
  type ParquetReadBudget,
} from "./indexed-parquet.ts";

export interface FeedRange {
  blockStart?: number;
  blockEnd?: number;
  observedStart?: number;
  observedEnd?: number;
  cursor?: [number, number, number] | null;
}
export interface PackedFeed {
  base: string;
  selection: { firstBlock: number; lastBlock: number };
  root: HistoryFeedNode | null;
}
interface FeedRow {
  block_number: number | null;
  observed_at: number | null;
}

const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const suffix =
  /^(?:directory\/[0-9a-f]{64}\.json|(?:(?:stages|merges)\/[0-9a-f]{64}\/)?(?:[0-9a-f]\/)?(?:nodes\/[0-9a-f]{64}\.json|packs\/[0-9a-f]{64}\.bin))$/;
export function checkFeedNode(node: HistoryFeedNode, feed: PackedFeed): void {
  const base = feed.base;
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
    throw new Error("History feed node scope or bounds mismatch");
}

export function feedInverse(
  value: number,
  maximum: number,
  width: number,
): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("Invalid history feed ordering integer");
  return (maximum - value).toString(16).padStart(width, "0");
}

export function feedOrder(stamp: number, block: number, event: number): string {
  return (
    feedInverse(stamp, Number.MAX_SAFE_INTEGER, 14) +
    feedInverse(block, 0xffffffff, 8) +
    feedInverse(event, 0xffffffff, 8)
  );
}

async function inflate(
  raw: ArrayBuffer,
  size: number,
  budget: ParquetReadBudget,
): Promise<Uint8Array> {
  if (budget.decodedBytes + size > budget.maxBytes * 4)
    throw new Error("History feed decoded byte budget exceeded");
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
        throw new Error("History feed decoded size changed");
      output.set(next.value, offset);
      offset += next.value.length;
    }
    if (offset !== size) throw new Error("Truncated history feed page");
    return output;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Traversal validates the complete directory/page before yielding any of it. */
export async function* iteratePackedFeed<T extends FeedRow>(
  source: ParquetRangeSource,
  feed: PackedFeed,
  selector: FeedRange,
  budget: ParquetReadBudget,
  key: string,
  decode: (values: unknown, token: string) => T,
  readPage?: (
    node: Extract<HistoryFeedNode, { height: 0 }>,
  ) => Promise<ArrayBuffer>,
  decodePage?: (
    raw: Uint8Array,
  ) => { token: string; values: unknown }[] | undefined,
): AsyncGenerator<{ token: string; row: T }> {
  const after = selector.cursor ? feedOrder(...selector.cursor) : null;
  const cursorLower =
    key + (after === null ? "0".repeat(102) : after + "f".repeat(72));
  const timeLower =
    key +
    feedInverse(
      selector.observedEnd ?? Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      14,
    ) +
    "0".repeat(88);
  const lower = cursorLower > timeLower ? cursorLower : timeLower;
  const upper =
    key +
    feedInverse(selector.observedStart ?? 0, Number.MAX_SAFE_INTEGER, 14) +
    "f".repeat(88);
  const firstBlock = selector.blockStart ?? feed.selection.firstBlock;
  const lastBlock = selector.blockEnd ?? feed.selection.lastBlock;
  feedInverse(firstBlock, 0xffffffff, 8);
  feedInverse(lastBlock, 0xffffffff, 8);

  async function* walk(
    node: HistoryFeedNode,
  ): AsyncGenerator<{ token: string; row: T }> {
    checkFeedNode(node, feed);
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
        throw new Error("History feed directory census or ordering mismatch");
      children.forEach((child) => checkFeedNode(child, feed));
      for (const child of children) yield* walk(child);
      return;
    }
    const raw = readPage
      ? await readPage(node)
      : await file.slice(node.offset, node.offset + node.length);
    const inflated = await inflate(raw, node.decodedBytes, budget);
    let records = decodePage?.(inflated);
    if (!records) {
      const decoded = text.decode(inflated);
      if (!decoded.endsWith("\n"))
        throw new Error("Truncated history feed record");
      records = decoded
        .slice(0, -1)
        .split("\n")
        .map((line) => {
          const token = line.slice(0, 166);
          if (!/^[0-9a-f]{166}$/.test(token) || line[166] !== "\t")
            throw new Error("Invalid history feed record token");
          const values: unknown = JSON.parse(line.slice(167));
          return { token, values };
        });
    }
    const entries = records.map(({ token, values }) => {
      const row = decode(values, token);
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
      throw new Error("History feed page bounds or census mismatch");
    for (const entry of entries) {
      if (entry.token.slice(0, 64) !== key) continue;
      const { row } = entry;
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
