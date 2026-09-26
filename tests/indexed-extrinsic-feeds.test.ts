import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadIndexedExtrinsicFeedPage } from "../src/indexed-extrinsic-feeds.ts";
import {
  validateExtrinsicFeed,
  iterateExtrinsicFeed,
  extrinsicFeedPage,
  type ExtrinsicFeedSelector,
  type ExtrinsicFeedPointer,
} from "../src/history-extrinsic-feed.ts";
import { readHistoryPointers } from "../src/history-generation.ts";
import { parquetReadBudget, r2ParquetSource } from "../src/indexed-parquet.ts";
import type { ExtrinsicsRow } from "../generated/lakehouse/types.ts";
import type { HistoryExtrinsicFeed } from "../schemas-src/artifacts/history-extrinsic-feed.ts";
import { loadExtrinsicFeedColdTier } from "../src/extrinsics-cold-tier.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";
import { hotHistoryFixture } from "./hot-history-fixture.ts";
import { historyAssetsFixture } from "./history-assets-fixture.ts";
import { HISTORY_ASSET_OBJECT_KEY } from "../schemas-src/artifacts/history-assets.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/extrinsic-feeds/native-tree.json", import.meta.url),
    "utf8",
  ),
) as {
  manifest: HistoryExtrinsicFeed;
  selection: HistoryExtrinsicFeed["selection"];
  rows: {
    fileId: number;
    sourceIdentity: string;
    row: number;
    data: ExtrinsicsRow;
  }[];
  objects: Record<string, { etag: string; base64: string }>;
};
function archive() {
  const feed = structuredClone(fixture.manifest),
    selected = structuredClone(fixture.selection);
  const base = `metagraph/indexed-history/v1/mainnet/extrinsics`;
  const manifest = `${base}/generations/${selected.generation}/feeds/v1/manifest.json`;
  const pointer = `${base}/current.json`,
    ceilingKey = `${base}/source-ceiling.json`;
  const objects = new Map(
    Object.entries(fixture.objects).map(([key, value]) => [
      key,
      { raw: Buffer.from(value.base64, "base64"), etag: value.etag },
    ]),
  );
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value)),
      etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag });
    return { key, etag, bytes: raw.length };
  };
  const ceiling = {
    version: 1,
    network: "mainnet",
    table: "extrinsics",
    through: selected.lastBlock,
    revision: "a".repeat(32),
  };
  const save = () => {
    put(pointer, { version: 1, ...selected });
    put(manifest, feed);
    put(ceilingKey, ceiling);
  };
  save();
  const sizes = new Map<string, number>(),
    counts = new Map<string, number>();
  let onGet: ((key: string, count: number) => void) | undefined;
  const get = vi.fn(async (key: string, options?: R2GetOptions) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    onGet?.(key, count);
    const object = objects.get(key);
    if (!object) return null;
    const range =
      options?.range && "offset" in options.range ? options.range : undefined;
    const offset = range?.offset ?? 0,
      length = range?.length ?? object.raw.length;
    return {
      etag: object.etag,
      size: sizes.get(key) ?? object.raw.length,
      range: { offset, length },
      body: new Response(object.raw.subarray(offset, offset + length)).body,
      json: async () => JSON.parse(object.raw.toString()),
    };
  });
  return {
    feed,
    selected,
    manifest,
    pointer,
    ceilingKey,
    ceiling,
    objects,
    put,
    save,
    sizes,
    get,
    env: { METAGRAPH_ARCHIVE: { get } },
    intercept(fn: typeof onGet) {
      onGet = fn;
    },
  };
}
const ordered = [...fixture.rows].sort(
  (a, b) =>
    b.data.observed_at! - a.data.observed_at! ||
    b.data.block_number! - a.data.block_number! ||
    b.data.extrinsic_index! - a.data.extrinsic_index! ||
    a.sourceIdentity.localeCompare(b.sourceIdentity) ||
    a.row - b.row,
);
function expected(selector: ExtrinsicFeedSelector) {
  return ordered
    .filter(
      ({ data: r }) =>
        (selector.signer === undefined || r.signer === selector.signer) &&
        (selector.module === undefined || r.call_module === selector.module) &&
        (selector.callFunction === undefined ||
          r.call_function === selector.callFunction) &&
        (selector.success === undefined || r.success === selector.success) &&
        r.block_number! >= (selector.blockStart ?? 0) &&
        r.block_number! <= (selector.blockEnd ?? 0xffffffff) &&
        r.observed_at! >= (selector.observedStart ?? 0) &&
        r.observed_at! <= (selector.observedEnd ?? Number.MAX_SAFE_INTEGER) &&
        (!selector.cursor ||
          r.observed_at! < selector.cursor[0] ||
          (r.observed_at === selector.cursor[0] &&
            (r.block_number! < selector.cursor[1] ||
              (r.block_number === selector.cursor[1] &&
                r.extrinsic_index! < selector.cursor[2])))),
    )
    .map((row) => row.data);
}
async function pointers(
  a: ReturnType<typeof archive>,
  selector: ExtrinsicFeedSelector = {},
) {
  const source = r2ParquetSource(a.env.METAGRAPH_ARCHIVE as never),
    result: ExtrinsicFeedPointer[] = [];
  for await (const row of iterateExtrinsicFeed(
    source,
    a.feed,
    selector,
    parquetReadBudget(128 * 1024 * 1024, 1024),
  ))
    result.push(row);
  return result;
}
async function* stream(rows: ExtrinsicFeedPointer[]) {
  yield* rows;
}

describe("qualified native extrinsic feeds", () => {
  it.each([false, true])(
    "hydrates identical full rows after every immutable feed object leaves R2 (partitioned: %s)",
    async (partitioned) => {
      const a = archive();
      const moved = [...a.objects].filter(([key]) =>
        HISTORY_ASSET_OBJECT_KEY.test(key),
      );
      expect(moved.length).toBeGreaterThan(0);
      const assets = historyAssetsFixture(
        moved.map(([key, object]) => ({
          key,
          etag: object.etag,
          chunks: partitioned
            ? Array.from(
                { length: Math.ceil(object.raw.length / 512) },
                (_, i) => object.raw.subarray(i * 512, (i + 1) * 512),
              )
            : [object.raw],
        })),
      );
      for (const [key] of moved) a.objects.delete(key);
      const env = { ...a.env, ...assets.env };
      if (partitioned) {
        const payloads = new Set(
          Object.values(assets.shards).flatMap((shard) =>
            Object.values(shard.objects).flatMap((object) =>
              object.chunks.map((chunk) => chunk.sha256),
            ),
          ),
        );
        const requestedHash = (request: Request) =>
          new URL(request.url).pathname.slice(1, -".mgpack".length);
        assets.root.partitionCount = 16;
        assets.root.prefixes = [a.manifest.slice(0, -"manifest.json".length)];
        assets.publish();
        env.HISTORY_ASSET_RELEASE = assets.env.HISTORY_ASSET_RELEASE;
        env.HISTORY_ASSETS = {
          fetch: vi.fn(async (request: Request) => {
            expect(payloads.has(requestedHash(request))).toBe(false);
            return assets.fetch(request);
          }),
        };
        Object.assign(
          env,
          Object.fromEntries(
            Array.from({ length: 16 }, (_, i) => {
              const partition = i.toString(16);
              return [
                `HISTORY_ASSETS_${partition}`,
                {
                  fetch: async (request: Request) => {
                    const hash = requestedHash(request);
                    expect(hash[0]).toBe(partition);
                    expect(payloads.has(hash)).toBe(true);
                    return assets.fetch(request);
                  },
                },
              ];
            }),
          ),
        );
      }
      for (const selector of [
        {},
        { signer: "account-1" },
        { module: "Module0" },
        { module: "Module1", callFunction: "function3" },
        { callFunction: "function2" },
        { success: true },
        { success: false },
        {
          signer: "account-1",
          module: "Module1",
          callFunction: "function3",
          success: false,
        },
        { module: "Module0", success: false },
        { signer: "absent" },
        { blockStart: 4, blockEnd: 9, observedStart: 1002, observedEnd: 1006 },
        { cursor: [1007, 13, 2] as [number, number, number] },
      ])
        expect(await loadIndexedExtrinsicFeedPage(env, selector, 200)).toEqual(
          expected(selector),
        );
      expect(await loadIndexedExtrinsicFeedPage(env, {}, 7, 3)).toEqual(
        expected({}).slice(3, 10),
      );
      expect(assets.fetch).toHaveBeenCalled();
      expect(
        a.get.mock.calls.some(([key]) => HISTORY_ASSET_OBJECT_KEY.test(key)),
      ).toBe(false);
      expect(a.get.mock.calls.some(([key]) => key.endsWith(".parquet"))).toBe(
        true,
      );
    },
  );
  it("merges hot rows with retained physical pointers while preserving filters, offsets and cursor order", async () => {
    const a = archive();
    const hot = [true, false, null].map((success, i) => ({
      ...fixture.rows[0].data,
      block_number: 101 + i,
      extrinsic_index: i,
      observed_at: 1006 - i,
      call_args: '{"wide":9007199254740993}',
      success,
      fee_tao: i ? null : 1.25,
    }));
    const h = await hotHistoryFixture("extrinsics", 100, 103, hot);
    try {
      a.ceiling.through = 103;
      a.save();
      const env = { ...a.env, ...h.env };
      const all = [...expected({}), ...hot].sort(
        (a, b) =>
          b.observed_at! - a.observed_at! ||
          b.block_number! - a.block_number! ||
          b.extrinsic_index! - a.extrinsic_index!,
      );
      expect(await loadIndexedExtrinsicFeedPage(env, {}, 200)).toEqual(all);
      expect(await loadIndexedExtrinsicFeedPage(env, {}, 5, 3)).toEqual(
        all.slice(3, 8),
      );
      expect(
        await loadIndexedExtrinsicFeedPage(env, { success: false }, 200),
      ).toEqual(all.filter((row) => row.success === false));
      const at = hot[0];
      expect(
        await loadIndexedExtrinsicFeedPage(
          env,
          { cursor: [at.observed_at!, at.block_number!, at.extrinsic_index!] },
          200,
        ),
      ).toEqual(all.slice(all.indexOf(at) + 1));
      await h.db
        .prepare("DELETE FROM chain_detail_blocks WHERE block_number=102")
        .run();
      expect(await loadIndexedExtrinsicFeedPage(env, {}, 5)).toBeUndefined();
    } finally {
      await h.runtime.dispose();
    }
  });
  it("matches full Parquet rows for every filter, intersection, time window and physical tie", async () => {
    for (const selector of [
      {},
      { signer: "account-1" },
      { module: "Module0" },
      { module: "Module1", callFunction: "function3" },
      { callFunction: "function2" },
      { success: true },
      { success: false },
      {
        signer: "account-1",
        module: "Module1",
        callFunction: "function3",
        success: false,
      },
      { module: "Module0", success: false },
      { signer: "absent" },
      { blockStart: 4, blockEnd: 9, observedStart: 1002, observedEnd: 1006 },
      { blockStart: 9, blockEnd: 4 },
      { cursor: [1007, 13, 2] as [number, number, number] },
      { cursor: [1005, 2, 0] as [number, number, number], observedEnd: 1001 },
    ]) {
      const a = archive();
      expect(await loadIndexedExtrinsicFeedPage(a.env, selector, 200)).toEqual(
        expected(selector),
      );
    }
    const a = archive();
    expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 7, 3)).toEqual(
      expected({}).slice(3, 10),
    );
    expect(
      a.get.mock.calls.filter(([key]) => key.endsWith(".parquet")).length,
    ).toBeGreaterThan(0);
    expect(
      (await loadIndexedExtrinsicFeedPage(a.env, {}, 1))![0].call_args!.length,
    ).toBeGreaterThan(20000);
  });
  it("serves the public feed and cursor from qualified objects without SQL", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("SQL forbidden"));
    try {
      const a = archive(),
        response = await loadExtrinsicFeedColdTier(a.env as never, {
          limit: 3,
          offset: 2,
          module: "Module1",
          callFunction: "function3",
          success: false,
          blockStart: 0,
          blockEnd: 20,
          from: 1000,
          to: 1010,
        });
      expect(response?.extrinsics.length).toBe(3);
      expect(fetch).not.toHaveBeenCalled();
      const short = await loadExtrinsicFeedColdTier(archive().env as never, {
        limit: 3,
        module: "Absent",
        block: 7,
        blockStart: 4,
        blockEnd: 10,
      });
      expect(short?.extrinsics).toEqual([]);
      const corrupt = archive();
      corrupt.feed.rows++;
      corrupt.save();
      expect(
        await loadExtrinsicFeedColdTier(corrupt.env as never, { limit: 3 }),
      ).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  it("distinguishes missing qualification from corruption and fences the whole read", async () => {
    expect(await loadIndexedExtrinsicFeedPage({}, {}, 5)).toBeUndefined();
    for (const missing of ["pointer", "manifest", "ceilingKey"] as const) {
      const a = archive();
      a.objects.delete(a[missing]);
      expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 5)).toBeUndefined();
    }
    for (const mutate of [
      (a: ReturnType<typeof archive>) => {
        a.selected.firstBlock = 1;
      },
      (a: ReturnType<typeof archive>) => {
        a.ceiling.through = 101;
      },
    ]) {
      const a = archive();
      mutate(a);
      a.save();
      expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 5)).toBeUndefined();
    }
    for (const mutate of [
      (a: ReturnType<typeof archive>) => {
        a.sizes.set(a.manifest, 16385);
      },
      (a: ReturnType<typeof archive>) => {
        a.sizes.set(a.ceilingKey, 8193);
      },
      (a: ReturnType<typeof archive>) => {
        a.ceiling.network = "testnet";
      },
      (a: ReturnType<typeof archive>) => {
        a.ceiling.table = "blocks";
      },
      (a: ReturnType<typeof archive>) => {
        a.feed.rows++;
      },
      (a: ReturnType<typeof archive>) => {
        a.feed.sourceSnapshot = "2";
      },
    ]) {
      const a = archive();
      mutate(a);
      a.save();
      const before = currentIndexedHistoryFailureGeneration();
      expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 5)).toBeNull();
      expect(currentIndexedHistoryFailureGeneration()).toBeGreaterThan(before);
    }
    for (const remove of [false, true]) {
      const a = archive();
      a.intercept((key, count) => {
        if (key === a.ceilingKey && count === 2) {
          if (remove) a.objects.delete(key);
          else a.put(key, { ...a.ceiling, revision: "b".repeat(32) });
        }
      });
      expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 5)).toBeUndefined();
    }
  });
  it("deduplicates repeated captures across streams without collapsing distinct captures", async () => {
    const rows = await pointers(archive());
    expect(
      await extrinsicFeedPage([stream(rows), stream(rows)], 5001, 0),
    ).toEqual(rows);
    expect(
      await extrinsicFeedPage(
        [stream(rows.slice(0, 4)), stream(rows.slice(4))],
        7,
        2,
      ),
    ).toEqual(rows.slice(2, 9));
    expect(await extrinsicFeedPage([], 1, 0)).toEqual([]);
    for (const [limit, offset] of [
      [0, 0],
      [5002, 0],
      [1, -1],
      [1, 5001],
      [1.1, 0],
      [1, 0.1],
    ])
      await expect(extrinsicFeedPage([], limit, offset)).rejects.toThrow(
        "budget",
      );
    await expect(
      extrinsicFeedPage(
        Array.from({ length: 6 }, () => stream([])),
        1,
        0,
      ),
    ).rejects.toThrow("budget");
  });
  it("rejects malformed selectors and pointer source identities before returning rows", async () => {
    for (const selector of [
      { signer: "" },
      { module: "\n" },
      { callFunction: "café" },
    ])
      await expect(pointers(archive(), selector)).rejects.toThrow("selector");
    const a = archive(),
      list = await pointers(a),
      generation = JSON.parse(
        a.objects.get(a.selected.blockManifest.key)!.raw.toString(),
      ),
      source = r2ParquetSource(a.env.METAGRAPH_ARCHIVE as never);
    const hydrate = (items: Parameters<typeof readHistoryPointers>[3]) =>
      readHistoryPointers(
        source,
        generation,
        generation,
        items,
        parquetReadBudget(),
      );
    const one = list[0];
    expect(await hydrate([one, one])).toHaveLength(2);
    expect(await hydrate([])).toEqual([]);
    await expect(hydrate(Array(5002).fill(one))).rejects.toThrow("budget");
    await expect(hydrate([{ ...one, sourceIdentity: "bad" }])).rejects.toThrow(
      "identity",
    );
    await expect(
      hydrate([one, { ...one, sourceIdentity: "b".repeat(64) }]),
    ).rejects.toThrow("identity");
    await expect(
      hydrate([{ ...one, sourceIdentity: "b".repeat(64) }]),
    ).rejects.toThrow("scope");
    await expect(hydrate([{ ...one, row: -1 }])).rejects.toThrow("outside");
  });
});

async function singlePage(
  a: ReturnType<typeof archive>,
  change: (row: ExtrinsicFeedPointer, index: number) => void = () => {},
) {
  const rows = await pointers(a);
  rows.forEach(change);
  const raw = Buffer.from(
    rows
      .map(
        (item) =>
          item.token +
          "\t" +
          JSON.stringify([
            item.filter.block_number,
            item.filter.extrinsic_index,
            item.filter.observed_at,
            item.filter.signer,
            item.filter.call_module,
            item.filter.call_function,
            item.filter.success,
            item.fileId,
          ]),
      )
      .join("\n") + "\n",
  );
  const compressed = gzipSync(raw),
    hash = createHash("sha256").update(compressed).digest("hex");
  const key = a.manifest.replace("manifest.json", `packs/${hash}.bin`),
    etag = createHash("md5").update(compressed).digest("hex");
  a.objects.set(key, { raw: compressed, etag });
  a.feed.entries = rows.length;
  a.feed.root = {
    height: 0,
    rows: rows.length,
    first: rows[0].token,
    last: rows.at(-1)!.token,
    minBlock: Math.min(...rows.map((row) => row.filter.block_number)),
    maxBlock: Math.max(...rows.map((row) => row.filter.block_number)),
    object: { key, etag, bytes: compressed.length },
    offset: 0,
    length: compressed.length,
    decodedBytes: raw.length,
  };
  a.save();
}

it("rejects row ordering, indexed predicates and hydrated payload discrepancies", async () => {
  const order = archive();
  await singlePage(order, (row, i) => {
    if (i === 0) row.filter.observed_at++;
  });
  await expect(pointers(order)).rejects.toThrow("ordering");
  const selected = archive();
  const list = await pointers(selected, { module: "Module0" });
  // A row bearing the module key must actually satisfy that indexed predicate.
  await singlePage(selected, (row) => {
    row.token = list[0].token.slice(0, 64) + row.token.slice(64);
    row.filter.call_module = "Wrong";
  });
  await expect(pointers(selected, { module: "Module0" })).rejects.toThrow(
    "selector",
  );
  const mismatch = archive();
  await singlePage(mismatch, (row, i) => {
    if (i === 0) row.filter.signer = "wrong signer";
  });
  expect(await loadIndexedExtrinsicFeedPage(mismatch.env, {}, 1)).toBeNull();
});

it("validates complete manifest identity and serves a proven empty testnet generation", async () => {
  for (const change of [
    (f: HistoryExtrinsicFeed) => {
      f.network = "testnet";
    },
    (f: HistoryExtrinsicFeed) => {
      f.generation = "b".repeat(64);
    },
    (f: HistoryExtrinsicFeed) => {
      f.selection.firstBlock = 1;
    },
    (f: HistoryExtrinsicFeed) => {
      f.selection.lastBlock = 99;
    },
    (f: HistoryExtrinsicFeed) => {
      f.plan.bytes = 32 * 1024 * 1024 + 1;
    },
    (f: HistoryExtrinsicFeed) => {
      f.entries = 1;
    },
    (f: HistoryExtrinsicFeed) => {
      f.entries = 601;
    },
    (f: HistoryExtrinsicFeed) => {
      f.selection.hashManifest = { key: "wrong", etag: "wrong", bytes: 1 };
    },
  ]) {
    const a = archive();
    change(a.feed);
    expect(() => validateExtrinsicFeed(a.feed, a.selected)).toThrow("identity");
  }
  const a = archive();
  a.selected.network = a.feed.network = a.feed.selection.network = "testnet";
  a.selected.firstBlock = a.feed.selection.firstBlock = 7700000;
  a.selected.lastBlock = a.feed.selection.lastBlock = 7700010;
  a.feed.rows = a.feed.entries = 0;
  a.feed.root = null;
  const root = `metagraph/indexed-history/v1/testnet/extrinsics/generations/${a.selected.generation}`;
  a.selected.blockManifest = a.put(`${root}/block-manifest.json`, {
    version: 1,
    network: "testnet",
    table: "extrinsics",
    generation: a.selected.generation,
    state: "complete",
    sourceSnapshot: a.feed.sourceSnapshot,
    rows: 0,
    files: [],
    blockIndex: { key: `${root}/blocks/index.json`, etag: "index", bytes: 1 },
  });
  a.feed.selection = a.selected;
  a.feed.plan.key = `${root}/feeds/v1/plan.json`;
  a.put(`${root}/feeds/v1/manifest.json`, a.feed);
  a.put(`metagraph/indexed-history/v1/testnet/extrinsics/current.json`, {
    version: 1,
    ...a.selected,
  });
  a.put(`metagraph/indexed-history/v1/testnet/extrinsics/source-ceiling.json`, {
    ...a.ceiling,
    network: "testnet",
    through: 7700010,
  });
  expect(
    await loadIndexedExtrinsicFeedPage(a.env, {}, 5, 0, "testnet"),
  ).toEqual([]);
  const response = await loadExtrinsicFeedColdTier(archive().env as never, {
    limit: 5,
    block: 7,
  });
  expect(response?.extrinsics).toHaveLength(
    Math.min(5, expected({ blockStart: 7, blockEnd: 7 }).length),
  );
});

it("opens only feed segments intersecting the requested block range", async () => {
  const a = archive();
  a.ceiling.through = a.selected.lastBlock + 5;
  a.save();
  const outer = (
    generation: string,
    firstBlock: number,
    lastBlock: number,
  ) => ({
    ...a.selected,
    generation,
    firstBlock,
    lastBlock,
    blockManifest: {
      key: `metagraph/indexed-history/v1/mainnet/extrinsics/generations/${generation}/block-manifest.json`,
      etag: "missing",
      bytes: 1,
    },
    hashManifest: undefined,
  });
  a.put(a.pointer, {
    version: 2,
    network: "mainnet",
    table: "extrinsics",
    segments: [
      a.selected,
      outer("8".repeat(64), a.selected.lastBlock + 1, a.ceiling.through),
    ],
  });
  const bounded = { blockStart: 2, blockEnd: 4 };
  expect(await loadIndexedExtrinsicFeedPage(a.env, bounded, 5001)).toEqual(
    expected(bounded),
  );
  expect(a.get.mock.calls.some(([key]) => key.includes("8".repeat(64)))).toBe(
    false,
  );
  expect(
    await loadIndexedExtrinsicFeedPage(
      a.env,
      { blockStart: a.ceiling.through + 1, blockEnd: a.ceiling.through + 2 },
      3,
    ),
  ).toEqual([]);
  expect(await loadIndexedExtrinsicFeedPage(a.env, {}, 3)).toBeUndefined();
  expect(
    await loadIndexedExtrinsicFeedPage(
      a.env,
      { blockStart: a.selected.lastBlock + 1, blockEnd: a.ceiling.through },
      3,
    ),
  ).toBeUndefined();
  a.objects.delete(a.manifest);
  expect(await loadIndexedExtrinsicFeedPage(a.env, bounded, 3)).toBeUndefined();
});
