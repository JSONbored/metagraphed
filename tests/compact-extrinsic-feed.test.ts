import { gunzipSync, gzipSync } from "node:zlib";
import type { HistoryFeedNode } from "../schemas-src/artifacts/history-account-feed.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compactExtrinsicFeed } from "../scripts/compact-extrinsic-feed.ts";
import {
  encodeExtrinsicPage,
  type ExtrinsicPageEntry,
} from "../scripts/lib/extrinsic-page-encoding.ts";
import { decodeExtrinsicPage } from "../src/history-extrinsic-page.ts";
import {
  iterateExtrinsicFeed,
  validateExtrinsicFeed,
  type ExtrinsicFeedSelector,
} from "../src/history-extrinsic-feed.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import type { HistoryExtrinsicFeed } from "../schemas-src/artifacts/history-extrinsic-feed.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/extrinsic-feeds/native-tree.json", import.meta.url),
    "utf8",
  ),
) as {
  manifest: HistoryExtrinsicFeed;
  objects: Record<string, { etag: string; base64: string }>;
};
const wire = JSON.parse(
  readFileSync(
    new URL("./fixtures/extrinsic-feeds/compact-page.json", import.meta.url),
    "utf8",
  ),
) as {
  entries: [string, ExtrinsicPageEntry["values"]][];
};
const entries = () =>
  wire.entries.map(([token, values]) => ({ token, values: [...values] }));
function archive(normalPages = true) {
  const objects = new Map<string, { raw: Buffer; etag: string }>(
    Object.entries(fixture.objects).map(([key, value]) => [
      key,
      { raw: Buffer.from(value.base64, "base64"), etag: value.etag },
    ]),
  );
  const writes: string[] = [];
  const store = {
    async read(key: string, etag: string, offset: number, length: number) {
      const object = objects.get(key);
      if (
        !object ||
        object.etag !== etag ||
        offset + length > object.raw.length
      )
        throw new Error("Pinned source changed");
      return Uint8Array.from(object.raw.subarray(offset, offset + length))
        .buffer;
    },
    async write(key: string, bytes: Uint8Array) {
      const raw = Buffer.from(bytes),
        etag = createHash("md5").update(raw).digest("hex");
      objects.set(key, { raw, etag });
      writes.push(key);
      return { key, etag, bytes: raw.length };
    },
  };
  const feed = structuredClone(fixture.manifest);
  if (normalPages) {
    const entries: ExtrinsicPageEntry[] = [];
    function walk(node: HistoryFeedNode) {
      const raw = objects.get(node.object.key)!.raw;
      if ("offset" in node) {
        const lines = gunzipSync(
          raw.subarray(node.offset, node.offset + node.length),
        )
          .toString()
          .trimEnd()
          .split("\n");
        for (const line of lines)
          entries.push({
            token: line.slice(0, 166),
            values: JSON.parse(line.slice(167)),
          });
      } else
        for (const child of JSON.parse(raw.toString()).children) walk(child);
    }
    walk(feed.root!);
    const base = feed.plan.key.replace(/plan.json$/, "");
    const put = (kind: "packs" | "directory", raw: Buffer) => {
      const hash = createHash("sha256").update(raw).digest("hex"),
        etag = createHash("md5").update(raw).digest("hex");
      const key = `${base}${kind}/${hash}.${kind === "packs" ? "bin" : "json"}`;
      objects.set(key, { raw, etag });
      return { key, etag, bytes: raw.length };
    };
    const children: HistoryFeedNode[] = [];
    for (let start = 0; start < entries.length; start += 256) {
      const rows = entries.slice(start, start + 256);
      const raw = Buffer.from(
        rows
          .map((row) => `${row.token}\t${JSON.stringify(row.values)}\n`)
          .join(""),
      );
      const packed = gzipSync(raw, { level: 6 });
      children.push({
        height: 0,
        rows: rows.length,
        first: rows[0].token,
        last: rows.at(-1)!.token,
        minBlock: Math.min(...rows.map((row) => Number(row.values[0]))),
        maxBlock: Math.max(...rows.map((row) => Number(row.values[0]))),
        object: put("packs", packed),
        offset: 0,
        length: packed.length,
        decodedBytes: raw.length,
      });
    }
    feed.root = {
      ...feed.root!,
      height: 1,
      object: put(
        "directory",
        Buffer.from(JSON.stringify({ version: 1, children })),
      ),
    };
  }
  return { objects, writes, store, feed };
}
async function query(
  a: ReturnType<typeof archive>,
  feed: HistoryExtrinsicFeed,
  selector: ExtrinsicFeedSelector,
) {
  const rows = [];
  for await (const row of iterateExtrinsicFeed(
    a.store,
    feed,
    selector,
    parquetReadBudget(16 * 1024 * 1024, 4096),
  ))
    rows.push(row);
  return rows;
}

describe("bounded extrinsic feed compaction", () => {
  it("preserves independent pointer fixtures across selectors, cursors and intersections", async () => {
    const a = archive();
    const result = await compactExtrinsicFeed(
      a.feed,
      a.feed.selection,
      a.store,
    );
    expect(result.manifest.encoding).toBe("extrinsic-mixed-gzip-v1");
    expect(result.stats.entries).toBe(a.feed.entries);
    expect(result.stats.newPageBytes).toBeLessThan(result.stats.oldPageBytes);
    expect(result.stats.compactPages).toBeGreaterThan(0);
    expect(result.manifest.selection).toEqual(a.feed.selection);
    expect(result.entryDigest).toMatch(/^[a-f0-9]{64}$/);
    const selectors: ExtrinsicFeedSelector[] = [
      {},
      { success: true },
      { success: false },
      { blockStart: 3, blockEnd: 9 },
      { observedStart: 999, observedEnd: 1007 },
      { cursor: [1005, 5, 2] },
    ];
    const all = await query(a, a.feed, {});
    for (const row of all.slice(0, 12)) {
      const { signer, call_module, call_function, success } = row.filter;
      if (signer) selectors.push({ signer });
      if (call_module) selectors.push({ module: call_module });
      if (call_function) selectors.push({ callFunction: call_function });
      if (call_module && call_function)
        selectors.push({ module: call_module, callFunction: call_function });
      if (signer && success !== null) selectors.push({ signer, success });
    }
    for (const selector of selectors)
      expect(await query(a, result.manifest, selector)).toEqual(
        await query(a, a.feed, selector),
      );
    const again = await compactExtrinsicFeed(
      result.manifest,
      a.feed.selection,
      a.store,
    );
    expect(again.entryDigest).toBe(result.entryDigest);
    expect(again.stats.newPageBytes).toBeLessThanOrEqual(
      result.stats.newPageBytes,
    );
    for (const key of Object.keys(fixture.objects))
      expect(a.objects.has(key)).toBe(true);
    expect(
      a.writes.every(
        (key) =>
          key.includes("/feeds/v1/merges/") && !key.endsWith("manifest.json"),
      ),
    ).toBe(true);
  });

  it("retains tiny pages byte-for-byte when compact output would grow", async () => {
    const a = archive(false);
    const result = await compactExtrinsicFeed(
      a.feed,
      a.feed.selection,
      a.store,
    );
    expect(result.manifest).toEqual(a.feed);
    expect(result.stats.compactPages).toBe(0);
    expect(result.stats.newPageBytes).toBe(result.stats.oldPageBytes);
    expect(result.outputs).toEqual([]);
  });

  it("stages a mixed subtree and retains every unchanged sibling", async () => {
    const a = archive();
    const original = JSON.parse(
      a.objects.get(a.feed.root!.object.key)!.raw.toString(),
    );
    const result = await compactExtrinsicFeed(
      a.feed,
      a.feed.selection,
      a.store,
      { path: [0] },
    );
    const updated = JSON.parse(
      a.objects.get(result.manifest.root!.object.key)!.raw.toString(),
    );
    expect(updated.children.slice(1)).toEqual(original.children.slice(1));
    expect(await query(a, result.manifest, {})).toEqual(
      await query(a, a.feed, {}),
    );
  });

  it("retains the previously accepted legacy encoding and rejects unrelated formats", async () => {
    const a = archive();
    const old = { ...a.feed, encoding: "account-mixed-gzip-v2" as const };
    expect(validateExtrinsicFeed(old, a.feed.selection)).toEqual(old);
    expect(await query(a, old, {})).toEqual(await query(a, a.feed, {}));
    expect(() =>
      validateExtrinsicFeed({ ...old, encoding: "unknown" }, a.feed.selection),
    ).toThrow();
  });

  it("refuses mutation when input identity or resource limits are invalid", async () => {
    for (const options of [
      { maxPages: 1 },
      { maxReadBytes: 1 },
      { maxRequests: 1 },
      { maxWriteBytes: 1 },
      { path: [63] },
    ]) {
      const a = archive();
      await expect(
        compactExtrinsicFeed(a.feed, a.feed.selection, a.store, options),
      ).rejects.toThrow();
      expect(a.writes.some((key) => key.endsWith("manifest.json"))).toBe(false);
    }
    const a = archive();
    await expect(
      compactExtrinsicFeed(
        a.feed,
        { ...a.feed.selection, generation: "b".repeat(64) },
        a.store,
      ),
    ).rejects.toThrow("identity");
    expect(a.writes).toEqual([]);
  });
});

describe("extrinsic page encoding", () => {
  it("preserves every bit, boolean, null and UTF-16 string from independent wire data", () => {
    expect(decodeExtrinsicPage(encodeExtrinsicPage(entries())!)).toEqual(
      entries(),
    );
    const values = entries();
    values[0].values[7] = -0;
    expect(
      Object.is(
        decodeExtrinsicPage(encodeExtrinsicPage(values)!)![0].values[7],
        -0,
      ),
    ).toBe(true);
  });
  it("retains legacy data when a dictionary exceeds either bounded encoding limit", () => {
    for (const value of ["x".repeat(256 * 1024 + 1), "\u0000".repeat(50000)]) {
      const rows = entries();
      rows[0].values[3] = value;
      expect(encodeExtrinsicPage(rows)).toBeUndefined();
    }
  });
  it("rejects invalid row shapes, numbers, flags, ordering and identity", () => {
    const bad: ExtrinsicPageEntry[][] = [
      [],
      Array(257).fill(entries()[0]),
      entries().reverse(),
    ];
    for (const column of [0, 1, 2, 7]) {
      for (const value of [-1, 0.5, Infinity, null]) {
        const rows = entries();
        rows[0].values[column] = value;
        bad.push(rows);
      }
    }
    for (const value of [0, 1, "true"]) {
      const rows = entries();
      rows[0].values[6] = value;
      bad.push(rows);
    }
    const identity = entries();
    identity[0].token = "invalid";
    bad.push(identity);
    const order = entries();
    order[0].values[2] = 1001;
    bad.push(order);
    const width = entries();
    width[0].values.pop();
    bad.push(width);
    for (const rows of bad) expect(() => encodeExtrinsicPage(rows)).toThrow();
  });
});
