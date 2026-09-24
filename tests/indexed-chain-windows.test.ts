import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import * as generationReader from "../src/history-generation.ts";
import {
  loadIndexedChainWindow,
  loadIndexedChainWindowStats,
} from "../src/indexed-chain-windows.ts";
import {
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
} from "../src/chain-events-cold-tier.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";
import type { HistorySelection } from "../schemas-src/artifacts/history-selection.ts";
import type { ChainEventsRow } from "../generated/lakehouse/types.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";
import { hotHistoryFixture } from "./hot-history-fixture.ts";

type Segment = Omit<Extract<HistorySelection, { version: 1 }>, "version">;
const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/chain-windows/native.json.gz", import.meta.url),
    ),
  ).toString(),
) as {
  segments: Segment[];
  rows: {
    generation: string;
    network: ChainNetworkId;
    fileId: number;
    sourceIdentity: string;
    row: number;
    data: ChainEventsRow;
  }[];
  objects: Record<string, { etag: string; base64: string }>;
};
for (const value of fixture.rows) {
  const args = value.data.args as unknown as { wide: string; row: number };
  value.data.args = JSON.stringify({
    wide: args.wide,
    value: "payload-λ".repeat(400),
    row: args.row,
  })
    .replaceAll(":", ": ")
    .replaceAll(",", ", ")
    .replaceAll("λ", "\\u03bb");
}
function archive(network: ChainNetworkId = "mainnet") {
  const segments = structuredClone(
    fixture.segments.filter((s) => s.network === network),
  );
  const base = `metagraph/indexed-history/v1/${network}/chain_events`,
    pointer = `${base}/current.json`,
    ceilingKey = `${base}/source-ceiling.json`;
  const objects = new Map(
    Object.entries(fixture.objects).map(([key, value]) => [
      key,
      { raw: Buffer.from(value.base64, "base64"), etag: value.etag },
    ]),
  );
  function put(key: string, value: unknown) {
    const raw = Buffer.from(JSON.stringify(value)),
      etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag });
    return { key, etag, bytes: raw.length };
  }
  const ceiling = {
    version: 1,
    network,
    table: "chain_events",
    through: segments.at(-1)!.lastBlock,
    revision: "a".repeat(32),
  };
  const save = () => {
    put(pointer, { version: 2, network, table: "chain_events", segments });
    put(ceilingKey, ceiling);
  };
  save();
  const sizes = new Map<string, number>(),
    counts = new Map<string, number>();
  let onGet: ((key: string, count: number) => void) | undefined;
  const reads: { key: string; offset: number; length: number }[] = [];
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
    reads.push({ key, offset, length });
    return {
      etag: object.etag,
      size: sizes.get(key) ?? object.raw.length,
      range: { offset, length },
      body: new Response(object.raw.subarray(offset, offset + length)).body,
      json: async () => JSON.parse(object.raw.toString()),
    };
  });
  return {
    segments,
    pointer,
    ceilingKey,
    ceiling,
    objects,
    sizes,
    put,
    save,
    get,
    reads,
    env: { METAGRAPH_ARCHIVE: { get }, ICEBERG_BLOCKS_MAX: ceiling.through },
    intercept(fn: typeof onGet) {
      onGet = fn;
    },
  };
}
const ordered = [...fixture.rows].sort(
  (a, b) =>
    b.data.block_number! - a.data.block_number! ||
    (b.data.event_index ?? -1) - (a.data.event_index ?? -1) ||
    a.sourceIdentity.localeCompare(b.sourceIdentity) ||
    a.fileId - b.fileId ||
    a.row - b.row,
);
function expected(
  network: ChainNetworkId,
  first: number,
  last: number,
  pallet?: string,
  method?: string,
  cursor?: number[],
) {
  return ordered
    .filter(
      ({ network: n, data: r }) =>
        n === network &&
        r.block_number! >= first &&
        r.block_number! <= last &&
        (pallet === undefined || r.pallet === pallet) &&
        (method === undefined || r.method === method) &&
        (!cursor ||
          r.block_number! < cursor[1] ||
          (r.event_index !== null && r.event_index! < cursor[2])),
    )
    .map((r) => r.data);
}
it("keeps raw-event pages and full activity counts available across the publication seam", async () => {
  const a = archive();
  const hot = [0, 1, 2].map((i) => ({
    block_number: 65550 + i,
    event_index: i,
    observed_at: 2000,
    pallet: "Balances",
    method: i === 2 ? "NewMethod" : "Transfer",
    args: '{"wide":9007199254740993}',
    phase: "ApplyExtrinsic",
    extrinsic_index: 0,
  }));
  const h = await hotHistoryFixture("chain_events", 65549, 65552, hot);
  try {
    a.ceiling.through = 65552;
    a.save();
    const env = { ...a.env, ...h.env };
    const rows = [...expected("mainnet", 65530, 65549), ...hot].sort(
      (a, b) =>
        b.block_number! - a.block_number! ||
        (b.event_index ?? -1) - (a.event_index ?? -1),
    );
    expect(
      await loadIndexedChainWindow(env, {
        first: 65530,
        last: 65552,
        limit: 5001,
      }),
    ).toEqual(rows);
    expect(
      await loadIndexedChainWindow(env, {
        first: 65530,
        last: 65552,
        limit: 2,
        pallet: "Balances",
        method: "Transfer",
      }),
    ).toEqual(
      rows
        .filter((r) => r.pallet === "Balances" && r.method === "Transfer")
        .slice(0, 2),
    );
    expect(
      await loadIndexedChainWindow(env, {
        first: 65530,
        last: 65551,
        limit: 5,
        cursor: [2000, 65551, 1],
      }),
    ).toEqual(
      rows
        .filter(
          (r) =>
            r.block_number! < 65551 ||
            (r.block_number === 65551 && r.event_index! < 1),
        )
        .slice(0, 5),
    );
    expect(
      await loadIndexedChainWindow(env, {
        first: 65530,
        last: 65552,
        limit: 2,
        cursor: [2000, 65552, 3],
      }),
    ).toEqual(rows.slice(0, 2));
    const before = await loadIndexedChainWindowStats(env, 65530, 65549);
    const after = await loadIndexedChainWindowStats(env, 65530, 65552);
    const count = (groups: Record<string, unknown>[], method: string) =>
      groups.find((r) => r.pallet === "Balances" && r.method === method)
        ?.count ?? 0;
    expect(count(after!, "Transfer")).toBe(
      Number(count(before!, "Transfer")) + 2,
    );
    expect(
      count(
        (await loadIndexedChainWindowStats(env, 65550, 65552))!,
        "NewMethod",
      ),
    ).toBe(1);
    expect(
      after!.every(
        (row) => Object.keys(row).sort().join() === "count,method,pallet",
      ),
    ).toBe(true);
    await h.db
      .prepare("DELETE FROM chain_detail_blocks WHERE block_number=65551")
      .run();
    expect(
      await loadIndexedChainWindowStats(env, 65530, 65552),
    ).toBeUndefined();
  } finally {
    await h.runtime.dispose();
  }
});
it("native windows preserve full payloads, physical captures, page order and filter/cursor parity on both networks", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const first = network === "mainnet" ? 65530 : 7700000,
      last = first + 19;
    for (const query of [
      { first, last, limit: 1 },
      { first, last, limit: 2 },
      { first, last, limit: 13 },
      { first, last, limit: 5001 },
      { first: first + 5, last: first + 15, limit: 25, pallet: "Balances" },
      { first, last, limit: 11, method: "Transfer" },
      { first, last, limit: 50, pallet: "Subtensor", method: "M001" },
      { first, last: first + 13, limit: 20, cursor: [1000, first + 13, 5] },
      { first, last, limit: 50, pallet: "Missing" },
      { first: last + 1, last: last + 5, limit: 10 },
    ]) {
      const a = archive(network),
        result = await loadIndexedChainWindow(a.env, query, network);
      expect(result).toEqual(
        expected(
          network,
          query.first,
          query.last,
          query.pallet,
          query.method,
          query.cursor,
        ).slice(0, query.limit),
      );
      expect(a.reads.reduce((sum, r) => sum + r.length, 0)).toBeLessThan(
        8 * 1024 * 1024,
      );
    }
  }
});
it("native stats count every capture across shards and generations, use deterministic ties, and cap the published groups", async () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const a = archive(network),
      last = a.ceiling.through,
      groups = new Map<
        string,
        { pallet: string | null; method: string | null; count: number }
      >();
    for (const row of expected(network, last - 19, last)) {
      const key = JSON.stringify([row.pallet, row.method]),
        prior = groups.get(key);
      if (prior) prior.count++;
      else
        groups.set(key, { pallet: row.pallet!, method: row.method!, count: 1 });
    }
    const order = (a: string | null, b: string | null) =>
      a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
    const rows = [...groups.values()]
      .sort(
        (a, b) =>
          b.count - a.count ||
          order(a.pallet, b.pallet) ||
          order(a.method, b.method),
      )
      .slice(0, 100);
    expect(
      await loadIndexedChainWindowStats(a.env, last - 19, last, network),
    ).toEqual(rows);
    expect(rows.length).toBe(100);
    expect(
      await loadIndexedChainWindowStats(a.env, last + 1, last + 5, network),
    ).toEqual([]);
    const metadataReads = a.reads.filter((r) => r.key.endsWith(".parquet"));
    expect(metadataReads.length).toBeGreaterThan(0);
  }
});
it("the public feed and stats use qualified ordinary R2 windows without a SQL request", async () => {
  const a = archive(),
    first = 65530,
    last = a.ceiling.through,
    fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No SQL"));
  try {
    const page = await loadChainEventsColdTier(a.env as never, {
      limit: 5,
      before: last + 1,
    });
    expect(page?.count).toBe(5);
    expect(page?.events.map((r) => r.block_number)).toEqual([
      last,
      last,
      last,
      last,
      last,
    ]);
    const next = await loadChainEventsColdTier(a.env as never, {
      limit: 5,
      cursor: page?.next_cursor,
    });
    expect(next?.events[0].event_index).toBeLessThan(
      page!.events.at(-1)!.event_index as number,
    );
    const sparse = await loadChainEventsColdTier(a.env as never, {
      limit: 50,
      pallet: "Missing",
      before: last + 1,
    });
    expect(sparse).toEqual({
      count: 0,
      next_before: last - 5000,
      next_cursor: null,
      events: [],
    });
    const stats = await loadChainEventsStatsColdTier(a.env as never, 20);
    expect(stats?.activity).toEqual(
      await loadIndexedChainWindowStats(archive().env, first, last),
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
});
it("coverage fences distinguish an unavailable index from verified empty history", async () => {
  const query = { first: 65530, last: 65549, limit: 10 };
  expect(await loadIndexedChainWindow({}, query)).toBeUndefined();
  expect(
    await loadIndexedChainWindowStats({}, query.first, query.last),
  ).toBeUndefined();
  for (const which of [
    "selection",
    "ceiling",
    "floor",
    "tail",
    "race",
    "gone",
  ]) {
    const a = archive();
    if (which === "selection") a.objects.delete(a.pointer);
    if (which === "ceiling") a.objects.delete(a.ceilingKey);
    if (which === "floor") {
      a.segments[0].firstBlock = 65531;
      a.save();
    }
    if (which === "tail") {
      a.segments.pop();
      a.save();
    }
    if (which === "race" || which === "gone")
      a.intercept((key, count) => {
        if (key === a.ceilingKey && count === 2) {
          if (which === "gone") a.objects.delete(key);
          else a.put(key, { ...a.ceiling, revision: "b".repeat(32) });
        }
      });
    expect(await loadIndexedChainWindow(a.env, query), which).toBeUndefined();
  }
  const stats = archive();
  stats.intercept((key, count) => {
    if (key === stats.ceilingKey && count === 2) stats.objects.delete(key);
  });
  expect(
    await loadIndexedChainWindowStats(stats.env, 65530, 65549),
  ).toBeUndefined();
});
it("invalid windows, oversized ceilings and corrupt retained identities decline without hiding as empty", async () => {
  for (const query of [
    { first: -1, last: 2, limit: 1 },
    { first: 1.5, last: 2, limit: 1 },
    { first: 3, last: 2, limit: 1 },
    { first: 0, last: 5001, limit: 1 },
    { first: 0xffffffff, last: 0x100000000, limit: 1 },
    { first: 1, last: 2.5, limit: 1 },
    { first: 1, last: 2, limit: 0 },
    { first: 1, last: 2, limit: 5002 },
    { first: 1, last: 2, limit: 1.5 },
  ])
    expect(await loadIndexedChainWindow(archive().env, query)).toBeNull();
  for (const which of [
    "size",
    "network",
    "table",
    "etag",
    "manifest",
    "pointer",
    "payload",
  ]) {
    const a = archive();
    if (which === "size") a.sizes.set(a.ceilingKey, 8193);
    if (which === "network") a.ceiling.network = "testnet";
    if (which === "table") a.ceiling.table = "blocks";
    a.save();
    if (which === "etag") a.objects.get(a.ceilingKey)!.etag = "";
    if (which === "manifest")
      a.objects.get(a.segments[0].blockManifest.key)!.etag = "changed";
    if (which === "pointer" || which === "payload") {
      const manifest = JSON.parse(
        a.objects.get(a.segments[1].blockManifest.key)!.raw.toString(),
      );
      if (which === "pointer") {
        const index = JSON.parse(
          a.objects.get(manifest.blockIndex.key)!.raw.toString(),
        );
        const shard = index.shards[0],
          raw = Buffer.from(a.objects.get(shard.key)!.raw);
        raw.writeBigUInt64LE(9999n, 16);
        a.objects.get(shard.key)!.raw = raw;
      } else {
        a.intercept((key, count) => {
          if (key === manifest.files[0].key && count === 2)
            a.objects.get(key)!.etag = "changed";
        });
      }
    }
    const before = currentIndexedHistoryFailureGeneration();
    expect(
      await loadIndexedChainWindow(a.env, {
        first: 65530,
        last: 65549,
        limit: 5001,
      }),
      which,
    ).toBeNull();
    expect(currentIndexedHistoryFailureGeneration()).toBe(before + 1);
  }
  expect(await loadIndexedChainWindowStats(archive().env, -1, 2)).toBeNull();
});
it("hydration checks its projected logical keys and bounded stats reject excessive groups", async () => {
  const original = generationReader.readHistoryPointers;
  const hydration = vi
    .spyOn(generationReader, "readHistoryPointers")
    .mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (rows[0]) rows[0].pallet = "changed";
      return rows;
    });
  try {
    expect(
      await loadIndexedChainWindow(archive().env, {
        first: 65530,
        last: 65549,
        limit: 1,
      }),
    ).toBeNull();
  } finally {
    hydration.mockRestore();
  }
  const scan = vi
    .spyOn(generationReader, "scanHistoryBlockRange")
    .mockImplementation(
      async (
        _source,
        _input,
        _scope,
        _first,
        _last,
        _columns,
        _budget,
        consume,
      ) => {
        for (let i = 0; i <= 65536; i++)
          consume(
            { pallet: "Pallet", method: `Method${i}` },
            { fileId: 0, sourceIdentity: "a".repeat(64), row: i },
          );
      },
    );
  try {
    expect(
      await loadIndexedChainWindowStats(archive().env, 65530, 65549),
    ).toBeNull();
  } finally {
    scan.mockRestore();
  }
});
it("public feeds fail closed for corrupt windows and keep indexed pallet/method filters", async () => {
  const a = archive();
  a.sizes.set(a.ceilingKey, 8193);
  expect(
    await loadChainEventsColdTier(a.env as never, { limit: 10, before: 65550 }),
  ).toBeNull();
  expect(await loadChainEventsStatsColdTier(a.env as never, 20)).toBeNull();
  const page = await loadChainEventsColdTier(archive().env as never, {
    limit: 20,
    pallet: "Balances",
    method: "Transfer",
    before: 65550,
  });
  expect(
    page!.events.every(
      (row) => row.pallet === "Balances" && row.method === "Transfer",
    ),
  ).toBe(true);
  const broken = archive(),
    manifest = JSON.parse(
      broken.objects.get(broken.segments[0].blockManifest.key)!.raw.toString(),
    );
  const index = JSON.parse(
    broken.objects.get(manifest.blockIndex.key)!.raw.toString(),
  );
  const shard = index.shards[0],
    raw = Buffer.from(broken.objects.get(shard.key)!.raw);
  raw.writeUInt32LE(raw.readUInt32LE(8), 24 + 8);
  broken.objects.get(shard.key)!.raw = raw;
  expect(
    await loadIndexedChainWindow(broken.env, {
      first: 65530,
      last: 65549,
      limit: 1,
    }),
  ).toBeNull();
});

it("stats ordering matches binary UTF-8 for Unicode identifiers and prefixes", async () => {
  const scan = vi
    .spyOn(generationReader, "scanHistoryBlockRange")
    .mockImplementation(
      async (
        _source,
        _input,
        _scope,
        _first,
        _last,
        _columns,
        _budget,
        consume,
      ) => {
        for (const pallet of ["\u{10000}", "\ue000", "P", "P0", ""])
          consume(
            { pallet, method: "M" },
            { fileId: 0, sourceIdentity: "a".repeat(64), row: 0 },
          );
      },
    );
  try {
    const result = await loadIndexedChainWindowStats(
      archive().env,
      65530,
      65549,
    );
    const names = ["\u{10000}", "\ue000", "P", "P0", ""].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    expect(result?.map((row) => row.pallet)).toEqual(names);
  } finally {
    scan.mockRestore();
  }
});
