import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compactAccountFeed } from "../scripts/compact-account-feed.ts";
import {
  encodeAccountPage,
  type AccountPageEntry,
} from "../scripts/lib/account-page-encoding.ts";
import { decodeAccountPage } from "../src/history-account-page.ts";
import { feedOrder } from "../src/history-feed-tree.ts";
import {
  iterateAccountFeed,
  mergeAccountFeedPage,
  type AccountFeedSelector,
} from "../src/history-account-feed.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import type {
  HistoryAccountFeed,
  HistoryFeedNode,
} from "../schemas-src/artifacts/history-account-feed.ts";
import type { HistoryObject } from "../schemas-src/artifacts/history-generation.ts";

const hash = (raw: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(raw).digest("hex");
const independent = JSON.parse(
  readFileSync(
    new URL("./fixtures/account-feeds/compact-page.json", import.meta.url),
    "utf8",
  ),
) as { base64: string; entries: [string, AccountPageEntry["values"]][] };
const entries = () =>
  independent.entries.map(([token, values]) => ({
    token,
    values: [...values],
  }));

function storage() {
  const objects = new Map<string, { raw: Buffer; etag: string }>();
  const writes: HistoryObject[] = [],
    reads: string[] = [];
  const ranges: { key: string; offset: number; length: number }[] = [];
  function put(key: string, raw: Buffer) {
    const object = { key, bytes: raw.length, etag: hash(raw, "md5") };
    objects.set(key, { raw, etag: object.etag });
    return object;
  }
  const store = {
    async read(key: string, etag: string, offset: number, length: number) {
      reads.push(key);
      ranges.push({ key, offset, length });
      const object = objects.get(key);
      if (!object || object.etag !== etag)
        throw new Error("Pinned source identity changed");
      expect(offset + length).toBeLessThanOrEqual(object.raw.length);
      return Uint8Array.from(object.raw.subarray(offset, offset + length))
        .buffer;
    },
    async write(key: string, raw: Uint8Array) {
      const object = put(key, Buffer.from(raw));
      writes.push(object);
      return object;
    },
  };
  return { objects, writes, reads, ranges, put, store };
}
function synthetic() {
  const fixture = storage();
  const generation = "a".repeat(64),
    network = "testnet" as const;
  const prefix = `metagraph/indexed-history/v1/${network}/account_events/generations/${generation}/`;
  const base = prefix + "accounts/v1/";
  const query = hash(Buffer.from(JSON.stringify(["all", "*", null, null])));
  const records: AccountPageEntry[] = Array.from({ length: 256 }, (_, i) => {
    const values = [
      500,
      i,
      null,
      "Transfer",
      "account-a",
      "account-b",
      null,
      null,
      i / 16,
      null,
      1000 + i,
    ];
    return {
      token:
        query +
        feedOrder(1000 + i, 500, i) +
        "b".repeat(64) +
        i.toString(16).padStart(8, "0"),
      values,
    };
  }).sort((a, b) => a.token.localeCompare(b.token));
  const pages = [records.slice(0, 128), records.slice(128)];
  const raw = pages.map((rows) =>
    Buffer.from(
      rows.map((e) => `${e.token}\t${JSON.stringify(e.values)}\n`).join(""),
    ),
  );
  const compressed = raw.map((b) => gzipSync(b, { level: 1 }));
  const packed = Buffer.concat(compressed);
  const object = fixture.put(`${base}packs/${hash(packed)}.bin`, packed);
  const children: HistoryFeedNode[] = pages.map((rows, i) => ({
    height: 0,
    first: rows[0].token,
    last: rows.at(-1)!.token,
    rows: rows.length,
    minBlock: 500,
    maxBlock: 500,
    object,
    offset: i ? compressed[0].length : 0,
    length: compressed[i].length,
    decodedBytes: raw[i].length,
  }));
  const directory = Buffer.from(JSON.stringify({ version: 1, children }));
  const manifest: HistoryAccountFeed = {
    version: 1,
    network,
    table: "account_events",
    generation,
    sourceSnapshot: "1",
    rows: 256,
    entries: 256,
    state: "complete",
    encoding: "jsonl-gzip-v1",
    selection: {
      network,
      table: "account_events",
      generation,
      firstBlock: 0,
      lastBlock: 500,
      blockManifest: {
        key: prefix + "block-manifest.json",
        bytes: 1,
        etag: "unused",
      },
    },
    plan: { key: base + "plan.json", bytes: 1, etag: "unused" },
    root: {
      height: 1,
      first: records[0].token,
      last: records.at(-1)!.token,
      rows: 256,
      minBlock: 500,
      maxBlock: 500,
      object: fixture.put(
        `${base}directory/${hash(directory)}.json`,
        directory,
      ),
    },
  };
  function setChildren(nodes: HistoryFeedNode[]) {
    const bytes = Buffer.from(JSON.stringify({ version: 1, children: nodes }));
    manifest.root = {
      ...manifest.root!,
      object: fixture.put(`${base}directory/${hash(bytes)}.json`, bytes),
    };
  }
  return { ...fixture, manifest, records, children, base, setChildren };
}
function repackFixture(
  f: ReturnType<typeof synthetic>,
  pages: Uint8Array[],
  reverse = false,
  gap = 0,
) {
  const compressed = pages.map((raw) => gzipSync(raw, { level: 6 }));
  const order = reverse ? [1, 0] : [0, 1];
  const raw = Buffer.concat([
    compressed[order[0]],
    Buffer.alloc(gap, 0xa5),
    compressed[order[1]],
  ]);
  const object = f.put(`${f.base}packs/${hash(raw)}.bin`, raw);
  for (const [position, index] of order.entries()) {
    const node = f.children[index];
    if (!("offset" in node)) throw new Error("Expected fixture leaf");
    Object.assign(node, {
      object,
      offset: position ? compressed[order[0]].length + gap : 0,
      length: compressed[index].length,
      decodedBytes: pages[index].length,
    });
  }
  f.setChildren(f.children);
  return object;
}
function rawPages(f: ReturnType<typeof synthetic>) {
  return f.children.map((node) => {
    if (!("offset" in node)) throw new Error("Expected fixture leaf");
    return gunzipSync(
      f.objects
        .get(node.object.key)!
        .raw.subarray(node.offset, node.offset + node.length),
    );
  });
}
async function query(
  f: ReturnType<typeof storage>,
  manifest: HistoryAccountFeed,
  selectors: AccountFeedSelector[] = [{ side: "all", account: "*" }],
) {
  const budget = parquetReadBudget();
  return mergeAccountFeedPage(
    selectors.map((s) => iterateAccountFeed(f.store, manifest, s, budget)),
    5001,
  );
}

describe("account page encoder", () => {
  it("round-trips the independent Python fixture's exact values and tokens", () => {
    const result = decodeAccountPage(encodeAccountPage(entries())!)!;
    expect(result).toEqual(entries());
    expect(Object.is(result[0].values[8], -0)).toBe(true);
    expect(result[0].values[9]).toBe(Number.MIN_VALUE);
    expect(result[1].values[8]).toBe(Number.MAX_VALUE);
    expect(result[0].values[4]).toBe("\ud800");
  });
  it("rejects malformed, unordered and schema-invalid input", () => {
    for (const value of [
      [],
      Array(257).fill(entries()[0]),
      [...entries()].reverse(),
      [entries()[0], entries()[0]],
    ])
      expect(() => encodeAccountPage(value)).toThrow();
    for (const change of [
      (e: AccountPageEntry) => {
        e.token = "invalid";
      },
      (e: AccountPageEntry) => {
        e.values.pop();
      },
      (e: AccountPageEntry) => {
        e.values[8] = Infinity;
      },
      (e: AccountPageEntry) => {
        e.values[0] = null;
      },
      (e: AccountPageEntry) => {
        e.values[1] = 0.5;
      },
      (e: AccountPageEntry) => {
        e.values[10] = 1;
      },
      (e: AccountPageEntry) => {
        e.values[4] = 123;
      },
    ]) {
      const value = entries();
      change(value[0]);
      expect(() => encodeAccountPage(value)).toThrow();
    }
  });
  it("leaves oversized code-unit and escaped-dictionary pages in legacy format", () => {
    for (const value of ["a".repeat(262145), "\ud800".repeat(45000)]) {
      const input = entries();
      input[0].values[4] = value;
      expect(encodeAccountPage(input)).toBeUndefined();
    }
  });
});

describe("bounded account-feed compaction", () => {
  it("shrinks real pages, verifies output, and preserves complete serving results", async () => {
    const f = synthetic(),
      original = structuredClone(f.manifest);
    const result = await compactAccountFeed(
      f.manifest,
      f.manifest.selection,
      f.store,
    );
    expect(result.stats.compactPages).toBe(2);
    expect(result.stats.entries).toBe(256);
    expect(result.stats.newPageBytes).toBeLessThan(result.stats.oldPageBytes);
    expect(result.manifest.encoding).toBe("account-mixed-gzip-v2");
    expect(await query(f, result.manifest)).toEqual(await query(f, original));
    expect(f.manifest).toEqual(original);
    expect(result.outputs).toHaveLength(2);
    for (const o of result.outputs) expect(f.reads).toContain(o.key);
    const oldPack = f.children[0].object.key;
    expect(f.reads.filter((key) => key === oldPack)).toHaveLength(3); // compaction plus both reader traversals
    expect(result.originals).toHaveLength(2);
    const again = await compactAccountFeed(
      result.manifest,
      result.manifest.selection,
      f.store,
    );
    expect(again.stats.compactPages).toBe(0);
    expect(again.outputs).toEqual([]);
    expect(again.manifest).toEqual(result.manifest);
  });
  it("rebuilds a selected path while preserving the other subtree's descriptors", async () => {
    const f = synthetic();
    const result = await compactAccountFeed(
      f.manifest,
      f.manifest.selection,
      f.store,
      { path: [0] },
    );
    const root = JSON.parse(
      f.objects.get(result.manifest.root!.object.key)!.raw.toString(),
    );
    expect(root.children[1]).toEqual(f.children[1]);
    expect(root.children[0].object.key).not.toBe(f.children[0].object.key);
    expect(result.stats.entries).toBe(128);
    expect(result.manifest.entries).toBe(256);
    expect(await query(f, result.manifest)).toEqual(await query(f, f.manifest));
  });
  it("prunes unselected pack gaps and fingerprints pages in token order despite reversed physical offsets", async () => {
    const baseline = synthetic();
    const expected = await compactAccountFeed(
      baseline.manifest,
      baseline.manifest.selection,
      baseline.store,
    );
    const f = synthetic();
    const object = repackFixture(f, rawPages(f), true, 1024 * 1024);
    const result = await compactAccountFeed(
      f.manifest,
      f.manifest.selection,
      f.store,
      { maxReadBytes: 64 * 1024 },
    );
    expect(result.entryDigest).toBe(expected.entryDigest);
    expect(result.digestFormat).toBe("sha256-ordered-page-digests-v1");
    const ranges = f.ranges.filter((r) => r.key === object.key);
    expect(ranges).toHaveLength(2);
    expect(ranges.reduce((sum, r) => sum + r.length, 0)).toBe(
      result.stats.oldPageBytes,
    );
    expect(await query(f, result.manifest)).toEqual(await query(f, f.manifest));
  });
  it("copies unchanged compact pages into replacement packs so they do not pin the old pack", async () => {
    const f = synthetic();
    const pages = rawPages(f);
    pages[0] = Buffer.from(encodeAccountPage(f.records.slice(0, 128))!);
    repackFixture(f, pages);
    f.manifest.encoding = "account-mixed-gzip-v2";
    const result = await compactAccountFeed(
      f.manifest,
      f.manifest.selection,
      f.store,
    );
    expect(result.stats.compactPages).toBe(1);
    expect(result.stats.unchangedPages).toBe(1);
    expect(result.replacedPages).toEqual(f.children);
    const { children } = JSON.parse(
      f.objects.get(result.manifest.root!.object.key)!.raw.toString(),
    ) as { children: HistoryFeedNode[] };
    expect(
      children.every((n) => n.object.key !== f.children[0].object.key),
    ).toBe(true);
    const old = f.children[0],
      next = children[0];
    if (!("offset" in old) || !("offset" in next))
      throw new Error("Expected leaf");
    expect(
      f.objects
        .get(next.object.key)!
        .raw.subarray(next.offset, next.offset + next.length),
    ).toEqual(
      f.objects
        .get(old.object.key)!
        .raw.subarray(old.offset, old.offset + old.length),
    );
    expect(await query(f, result.manifest)).toEqual(await query(f, f.manifest));
  });
  it("rejects overlapping pack ranges before writing replacement objects", async () => {
    const f = synthetic();
    if (!("offset" in f.children[1])) throw new Error("Expected leaf");
    f.children[1].offset--;
    f.setChildren(f.children);
    await expect(
      compactAccountFeed(f.manifest, f.manifest.selection, f.store),
    ).rejects.toThrow("overlapping source pages");
    expect(f.writes).toEqual([]);
  });
  it("rejects truncated records, invalid delimiters, decoded-size and page-census mismatches", async () => {
    for (const mode of ["newline", "delimiter", "size", "census", "gzip"]) {
      const f = synthetic();
      const pages = rawPages(f);
      if (mode === "newline") pages[0] = pages[0].subarray(0, -1);
      if (mode === "delimiter") pages[0][166] = 0x20;
      repackFixture(f, pages, false, 1024);
      const leaf = f.children[0];
      if (!("offset" in leaf)) throw new Error("Expected leaf");
      if (mode === "size") leaf.decodedBytes++;
      if (mode === "census") {
        leaf.rows--;
        f.children[1].rows++;
      }
      if (mode === "gzip") f.objects.get(leaf.object.key)!.raw[0] ^= 1;
      f.setChildren(f.children);
      await expect(
        compactAccountFeed(f.manifest, f.manifest.selection, f.store),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
    }
  });
  it("preserves real multi-level mixed fixture filters and physical captures", async () => {
    for (const name of ["native-tree", "compact-tree"]) {
      const input = JSON.parse(
        readFileSync(
          new URL(`./fixtures/account-feeds/${name}.json`, import.meta.url),
          "utf8",
        ),
      ) as {
        manifest: HistoryAccountFeed;
        objects: Record<string, { base64: string; etag: string }>;
      };
      const f = storage();
      for (const [key, object] of Object.entries(input.objects))
        f.put(key, Buffer.from(object.base64, "base64"));
      const result = await compactAccountFeed(
        input.manifest,
        input.manifest.selection,
        f.store,
      );
      expect(result.stats.entries).toBe(input.manifest.entries);
      for (const selectors of [
        [{ side: "all", account: "*" }],
        [
          { side: "hotkey", account: "account-0" },
          { side: "coldkey", account: "account-0" },
        ],
        [
          {
            side: "hotkey",
            account: "account-0",
            kind: "Transfer",
            counterparty: "account-1",
          },
        ],
        [
          {
            side: "coldkey",
            account: "account-4",
            netuid: 0,
            cursor: [10002, 3, 1],
            blockStart: 2,
            blockEnd: 4,
          },
        ],
        [{ side: "hotkey", account: "absent" }],
      ] satisfies AccountFeedSelector[][])
        expect(await query(f, result.manifest, selectors)).toEqual(
          await query(f, input.manifest, selectors),
        );
    }
  });
  it("enforces I/O, tree and staging budgets before returning a candidate manifest", async () => {
    for (const options of [
      { maxReadBytes: 1 },
      { maxRequests: 1 },
      { maxWriteBytes: 1 },
      { maxNodes: 1 },
      { maxPages: 1 },
      { maxReadBytes: 129 * 1024 * 1024 },
      { path: [2] },
      { path: [0, 0] },
    ]) {
      const f = synthetic();
      await expect(
        compactAccountFeed(f.manifest, f.manifest.selection, f.store, options),
      ).rejects.toThrow();
    }
  });
  it("rejects corrupt source bytes, directory census, and conflicting pack identities", async () => {
    const f = synthetic();
    f.objects.get(f.children[0].object.key)!.raw[0] ^= 1;
    await expect(
      compactAccountFeed(f.manifest, f.manifest.selection, f.store),
    ).rejects.toThrow("content hash");
    const c = synthetic();
    c.children[0].rows++;
    c.setChildren(c.children);
    await expect(
      compactAccountFeed(c.manifest, c.manifest.selection, c.store),
    ).rejects.toThrow("directory census");
    const d = synthetic();
    d.children[1].object = { ...d.children[1].object, etag: "changed" };
    d.setChildren(d.children);
    await expect(
      compactAccountFeed(d.manifest, d.manifest.selection, d.store),
    ).rejects.toThrow("identity conflict");
  });
  it("requires exact output identity and readback before returning any replacement", async () => {
    for (const mode of ["key", "bytes", "readback"]) {
      const f = synthetic();
      const store = {
        ...f.store,
        async write(key: string, raw: Uint8Array) {
          const object = await f.store.write(key, raw);
          if (mode === "readback") f.objects.get(key)!.raw[0] ^= 1;
          return {
            ...object,
            ...(mode === "key"
              ? { key: "wrong" }
              : mode === "bytes"
                ? { bytes: object.bytes + 1 }
                : {}),
          };
        },
      };
      await expect(
        compactAccountFeed(f.manifest, f.manifest.selection, store),
      ).rejects.toThrow(/identity|readback/);
    }
  });
  it("fails closed when directory output or verification exhausts a budget after pack staging", async () => {
    const baseline = synthetic();
    const result = await compactAccountFeed(
      baseline.manifest,
      baseline.manifest.selection,
      baseline.store,
    );
    for (const options of [
      { maxWriteBytes: result.stats.newPageBytes },
      { maxReadBytes: result.budget.bytes - 1 },
    ]) {
      const f = synthetic(),
        original = structuredClone(f.manifest);
      await expect(
        compactAccountFeed(f.manifest, f.manifest.selection, f.store, options),
      ).rejects.toThrow(/budget/);
      expect(f.writes.length).toBeGreaterThan(0);
      expect(f.manifest).toEqual(original);
    }
  });
  it("keeps empty feeds untouched and rejects a nonempty path into one", async () => {
    const f = synthetic(),
      feed = { ...f.manifest, entries: 0, rows: 0, root: null };
    const result = await compactAccountFeed(feed, feed.selection, f.store);
    expect(result.manifest).toEqual(feed);
    expect(result.outputs).toEqual([]);
    expect(f.reads).toEqual([]);
    await expect(
      compactAccountFeed(feed, feed.selection, f.store, { path: [0] }),
    ).rejects.toThrow("path outside");
  });
});
