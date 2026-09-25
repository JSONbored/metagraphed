import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import {
  HistoryFeedDirectorySchema,
  type HistoryFeedNode,
  type HistoryAccountFeed,
} from "../schemas-src/artifacts/history-account-feed.ts";
import {
  HistoryObjectSchema,
  type HistoryObject,
} from "../schemas-src/artifacts/history-generation.ts";
import { validateAccountFeed } from "../src/history-account-feed.ts";
import { decodeAccountPage } from "../src/history-account-page.ts";
import { checkFeedNode } from "../src/history-feed-tree.ts";
import { createAccountPageDigest } from "./lib/account-page-digest.ts";
import {
  boundedParquetBuffer,
  parquetReadBudget,
  type ParquetRangeSource,
} from "../src/indexed-parquet.ts";
import { encodeAccountPage } from "./lib/account-page-encoding.ts";

const MiB = 1024 * 1024;
const OptionsSchema = z.strictObject({
  path: z.array(z.int().min(0).max(63)).max(16).default([]),
  maxReadBytes: z
    .int()
    .positive()
    .max(128 * MiB)
    .default(64 * MiB),
  maxWriteBytes: z
    .int()
    .positive()
    .max(128 * MiB)
    .default(64 * MiB),
  maxRequests: z.int().positive().max(16384).default(4096),
  maxNodes: z.int().positive().max(16384).default(8192),
  maxPages: z.int().positive().max(8192).default(4096),
});
type Tree = { node: HistoryFeedNode; children?: Tree[]; changed: boolean };
type Leaf = Extract<HistoryFeedNode, { height: 0 }>;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Compact one bounded subtree using immutable, content-addressed output.
 * The sink must stage objects; this function never publishes a manifest or
 * deletes inputs. Publication and retirement require a separate reference fence.
 * All output is read back before a replacement manifest is returned. */
export async function compactAccountFeed(
  input: unknown,
  selection: HistoryAccountFeed["selection"],
  store: ParquetRangeSource & {
    write(key: string, bytes: Uint8Array): Promise<HistoryObject>;
  },
  options: unknown = {},
) {
  const config = OptionsSchema.parse(options),
    feed = validateAccountFeed(input, selection);
  const base = `metagraph/indexed-history/v1/${feed.network}/account_events/generations/${feed.generation}/accounts/v1/`;
  const run = digest(json({ version: 1, root: feed.root, path: config.path }));
  const outputBase = `${base}merges/${run}/`;
  const budget = parquetReadBudget(config.maxReadBytes, config.maxRequests);
  const originals = new Map<string, HistoryObject>();
  const outputs: HistoryObject[] = [];
  const replacedPages: Leaf[] = [];
  const pages = new Map<Tree, { raw: Uint8Array; decodedBytes: number }>();
  const leaves: Tree[] = [];
  const groups = new Map<string, Tree[]>();
  const pageDigests = new Map<Tree, string>();
  const digestPage = createAccountPageDigest();
  const digestFormat = "sha256-ordered-page-digests-v1" as const;
  const seenDirectories = new Set<string>();
  const stats = {
    nodes: 0,
    pages: 0,
    entries: 0,
    compactPages: 0,
    unchangedPages: 0,
    oldPageBytes: 0,
    newPageBytes: 0,
    decodedPageBytes: 0,
    writtenBytes: 0,
  };
  let previous: string | undefined;
  let chunks: Uint8Array[] = [],
    pending: Leaf[] = [],
    packBytes = 0;

  function register(object: HistoryObject) {
    const prior = originals.get(object.key);
    if (prior && (prior.etag !== object.etag || prior.bytes !== object.bytes))
      throw new Error("Account compaction object identity conflict");
    originals.set(object.key, object);
  }
  async function read(
    object: HistoryObject,
    start = 0,
    end = object.bytes,
  ): Promise<Uint8Array> {
    register(object);
    const raw = new Uint8Array(
      await boundedParquetBuffer(store, object, budget).slice(start, end),
    );
    // Partial pack reads use the source's conditional ETag/range contract,
    // then gzip integrity and the directory's exact page census. Only a full
    // object read can additionally verify its content-addressed filename.
    if (
      start === 0 &&
      end === object.bytes &&
      !object.key.endsWith(
        digest(raw) + (object.key.endsWith(".bin") ? ".bin" : ".json"),
      )
    )
      throw new Error("Account compaction source content hash mismatch");
    return raw;
  }
  async function write(
    kind: "packs" | "nodes",
    raw: Uint8Array,
  ): Promise<HistoryObject> {
    if (raw.length > (kind === "packs" ? 16 * MiB : 128 * 1024))
      throw new Error("Account compaction output object exceeds size bound");
    if (stats.writtenBytes + raw.length > config.maxWriteBytes)
      throw new Error("Account compaction write budget exceeded");
    const key = `${outputBase}${kind}/${digest(raw)}.${kind === "packs" ? "bin" : "json"}`;
    stats.writtenBytes += raw.length;
    const object = HistoryObjectSchema.parse(await store.write(key, raw));
    if (object.key !== key || object.bytes !== raw.length)
      throw new Error("Account compaction output identity mismatch");
    outputs.push(object);
    const restored = new Uint8Array(
      await boundedParquetBuffer(store, object, budget).slice(0, object.bytes),
    );
    if (digest(restored) !== digest(raw))
      throw new Error("Account compaction readback mismatch");
    return object;
  }
  async function flush() {
    if (!pending.length) return;
    const object = await write("packs", Buffer.concat(chunks));
    for (const node of pending) node.object = object;
    chunks = [];
    pending = [];
    packBytes = 0;
  }
  function check(node: HistoryFeedNode) {
    checkFeedNode(node, { ...feed, base });
    if (++stats.nodes > config.maxNodes)
      throw new Error("Account compaction node budget exceeded");
  }
  async function children(node: HistoryFeedNode): Promise<HistoryFeedNode[]> {
    if (node.height === 0 || seenDirectories.has(node.object.key))
      throw new Error("Account compaction repeated directory or invalid path");
    seenDirectories.add(node.object.key);
    const { children } = HistoryFeedDirectorySchema.parse(
      JSON.parse(text.decode(await read(node.object))),
    );
    if (
      children[0].first !== node.first ||
      children.at(-1)!.last !== node.last ||
      children.reduce((sum, child) => sum + child.rows, 0) !== node.rows ||
      Math.max(...children.map((child) => child.height)) + 1 !== node.height ||
      Math.min(...children.map((child) => child.minBlock)) !== node.minBlock ||
      Math.max(...children.map((child) => child.maxBlock)) !== node.maxBlock ||
      children.some((child, i) => i > 0 && children[i - 1].last >= child.first)
    )
      throw new Error("Account compaction directory census mismatch");
    for (const child of children) checkFeedNode(child, { ...feed, base });
    return children;
  }
  async function collect(node: HistoryFeedNode): Promise<Tree> {
    check(node);
    if (!("offset" in node)) {
      const descendants = [];
      for (const child of await children(node))
        descendants.push(await collect(child));
      return {
        node,
        children: descendants,
        changed: false,
      };
    }
    if (++stats.pages > config.maxPages)
      throw new Error("Account compaction page budget exceeded");
    if (previous !== undefined && previous >= node.first)
      throw new Error("Account compaction page order mismatch");
    previous = node.last;
    register(node.object);
    const tree = { node, changed: false };
    leaves.push(tree);
    const group = groups.get(node.object.key) ?? [];
    group.push(tree);
    groups.set(node.object.key, group);
    return tree;
  }
  function transcode(tree: Tree, original: Uint8Array) {
    const node = tree.node as Leaf;
    const raw = gunzipSync(original, { maxOutputLength: node.decodedBytes });
    if (raw.length !== node.decodedBytes)
      throw new Error("Account compaction decoded size mismatch");
    stats.decodedPageBytes += raw.length;
    let entries =
      feed.encoding === "account-mixed-gzip-v2"
        ? decodeAccountPage(raw)
        : undefined;
    if (!entries) {
      const lines = text.decode(raw);
      if (!lines.endsWith("\n"))
        throw new Error("Truncated account compaction page");
      entries = lines
        .slice(0, -1)
        .split("\n")
        .map((line) => {
          if (line[166] !== "\t")
            throw new Error("Invalid account compaction record");
          return {
            token: line.slice(0, 166),
            values: JSON.parse(line.slice(167)),
          };
        });
    }
    // Encoding validates every source row before any census check or write,
    // including pages that retain their original bytes. Do not validate twice.
    const encoded = encodeAccountPage(entries);
    if (
      entries.length !== node.rows ||
      entries[0].token !== node.first ||
      entries.at(-1)!.token !== node.last ||
      Math.min(...entries.map((entry) => Number(entry.values[0]))) !==
        node.minBlock ||
      Math.max(...entries.map((entry) => Number(entry.values[0]))) !==
        node.maxBlock
    )
      throw new Error("Account compaction page census mismatch");
    stats.entries += entries.length;
    stats.oldPageBytes += original.length;
    const candidate = encoded && gzipSync(encoded, { level: 6 });
    const compact = candidate && candidate.length < original.length;
    const recovered = compact
      ? decodeAccountPage(
          gunzipSync(candidate, { maxOutputLength: encoded.length }),
        )!
      : entries;
    const pageDigest = digestPage(entries);
    if (pageDigest !== digestPage(recovered))
      throw new Error("Account compaction round-trip content mismatch");
    pageDigests.set(tree, pageDigest);
    if (compact) stats.compactPages++;
    else stats.unchangedPages++;
    stats.newPageBytes += compact ? candidate.length : original.length;
    if (stats.newPageBytes > config.maxWriteBytes)
      throw new Error("Account compaction staging budget exceeded");
    // Copy unchanged slices so one page cannot pin a 16 MiB source range.
    // The staging byte cap bounds this map.
    pages.set(tree, {
      raw: compact ? candidate : Uint8Array.from(original),
      decodedBytes: compact ? encoded.length : node.decodedBytes,
    });
  }
  async function transcodeRanges() {
    for (const group of groups.values()) {
      group.sort((a, b) => (a.node as Leaf).offset - (b.node as Leaf).offset);
      for (let i = 1; i < group.length; i++) {
        const prior = group[i - 1].node as Leaf;
        if (prior.offset + prior.length > (group[i].node as Leaf).offset)
          throw new Error("Account compaction overlapping source pages");
      }
      for (let i = 0; i < group.length;) {
        const first = group[i].node as Leaf;
        let end = first.offset + first.length,
          next = i + 1;
        while (next < group.length) {
          const node = group[next].node as Leaf;
          if (node.offset !== end) break;
          end += node.length;
          next++;
        }
        // The validated source object caps every span at 16 MiB. Gaps are
        // deliberately excluded, even when many pages share a source pack.
        const raw = await read(first.object, first.offset, end);
        for (; i < next; i++) {
          const node = group[i].node as Leaf;
          transcode(
            group[i],
            raw.subarray(
              node.offset - first.offset,
              node.offset + node.length - first.offset,
            ),
          );
        }
      }
    }
  }
  async function repack(tree: Tree): Promise<void> {
    tree.changed = true;
    if (tree.children) {
      for (const child of tree.children) await repack(child);
      return;
    }
    const page = pages.get(tree)!;
    const node = tree.node as Leaf;
    if (packBytes + page.raw.length > 16 * MiB) await flush();
    const replacement: Leaf = {
      ...node,
      offset: packBytes,
      length: page.raw.length,
      decodedBytes: page.decodedBytes,
    };
    chunks.push(page.raw);
    pending.push(replacement);
    packBytes += page.raw.length;
    replacedPages.push(node);
    tree.node = replacement;
    pages.delete(tree);
  }
  async function rebuild(tree: Tree): Promise<HistoryFeedNode> {
    if (!tree.changed || !tree.children) return tree.node;
    const nodes = [];
    for (const child of tree.children) nodes.push(await rebuild(child));
    return {
      ...tree.node,
      object: await write("nodes", json({ version: 1, children: nodes })),
    };
  }

  if (!feed.root) {
    if (config.path.length)
      throw new Error("Account compaction path outside tree");
    return {
      manifest: feed,
      stats,
      budget,
      originals: [],
      outputs,
      replacedPages,
      digestFormat,
      entryDigest: digest(new Uint8Array()),
    };
  }
  const parents: {
    node: HistoryFeedNode;
    children: HistoryFeedNode[];
    index: number;
  }[] = [];
  let target = feed.root;
  for (const index of config.path) {
    check(target);
    const nodes = await children(target);
    if (!nodes[index]) throw new Error("Account compaction path outside tree");
    parents.push({ node: target, children: nodes, index });
    target = nodes[index];
  }
  const tree = await collect(target);
  await transcodeRanges();
  const orderedDigest = createHash("sha256");
  for (const leaf of leaves)
    orderedDigest.update(Buffer.from(pageDigests.get(leaf)!, "hex"));
  const entryDigest = orderedDigest.digest("hex");
  if (stats.entries !== target.rows)
    throw new Error("Account compaction round-trip census mismatch");
  if (stats.compactPages > 0) {
    await repack(tree);
    await flush();
  }
  let root = await rebuild(tree);
  if (tree.changed)
    for (const parent of parents.reverse()) {
      parent.children[parent.index] = root;
      root = {
        ...parent.node,
        object: await write(
          "nodes",
          json({ version: 1, children: parent.children }),
        ),
      };
    }
  else root = feed.root;
  const manifest = validateAccountFeed(
    {
      ...feed,
      encoding: tree.changed ? "account-mixed-gzip-v2" : feed.encoding,
      root,
    },
    selection,
  );
  return {
    manifest,
    stats,
    budget,
    originals: [...originals.values()],
    outputs,
    replacedPages,
    digestFormat,
    entryDigest,
  };
}
