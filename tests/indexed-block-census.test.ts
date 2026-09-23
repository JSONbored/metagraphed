import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test, vi } from "vitest";
import { loadIndexedBlockCensus } from "../src/indexed-block-census.ts";
import * as generations from "../src/history-generation.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { runLakehouseSeamWatchdog } from "../src/lakehouse-seam-watchdog.ts";

const base = "metagraph/indexed-history/v1/mainnet/blocks";
const ceilingKey = `${base}/source-ceiling.json`;
function fixture(
  blocks: number[][] = [
    [2, 2, 5],
    [7, 8, 9],
  ],
) {
  const objects = new Map<
    string,
    { raw: Buffer; etag: string; size: number }
  >();
  const put = (key: string, value: unknown) => {
    const raw = Buffer.from(JSON.stringify(value));
    const etag = createHash("md5").update(raw).digest("hex");
    objects.set(key, { raw, etag, size: raw.length });
    return { key, etag, bytes: raw.length };
  };
  const indexes: Record<string, unknown>[] = [];
  const manifests: Record<string, unknown>[] = [];
  const segments = blocks.map((rows, i) => {
    const generation = String(i + 1).repeat(64);
    const scope = {
      version: 1,
      generation,
      network: "mainnet",
      table: "blocks",
    };
    const root = `${base}/generations/${generation}`;
    const index = {
      ...scope,
      state: "complete",
      rows: rows.length,
      runs: rows.length,
      shards: rows.length
        ? [
            {
              ...scope,
              prefix: "0000",
              key: `${root}/blocks/0000.bin`,
              etag: "fixture",
              bytes: rows.length * 24,
              rows: rows.length,
              runs: rows.length,
              firstBlock: Math.min(...rows),
              lastBlock: Math.max(...rows),
            },
          ]
        : [],
    };
    indexes.push(index);
    const blockIndex = put(`${root}/blocks/index.json`, index);
    const manifest = {
      ...scope,
      state: "complete",
      sourceSnapshot: "9007199254740993",
      rows: rows.length,
      files: rows.length
        ? [
            {
              key: `${root}/files/00000.json`,
              etag: "fixture",
              bytes: 1,
              rows: rows.length,
            },
          ]
        : [],
      blockIndex,
    };
    manifests.push(manifest);
    return {
      generation,
      network: "mainnet",
      table: "blocks",
      firstBlock: i ? 6 : 0,
      lastBlock: i ? 9 : 5,
      blockManifest: put(`${root}/block-manifest.json`, manifest),
    };
  });
  const ceiling = {
    version: 1,
    network: "mainnet",
    table: "blocks",
    through: segments.at(-1)!.lastBlock,
    revision: "a".repeat(32),
  };
  const save = () => {
    for (const [i, segment] of segments.entries()) {
      manifests[i].blockIndex = put(
        `${base}/generations/${segment.generation}/blocks/index.json`,
        indexes[i],
      );
      segment.blockManifest = put(segment.blockManifest.key, manifests[i]);
    }
    put(`${base}/current.json`, {
      version: 2,
      network: "mainnet",
      table: "blocks",
      segments,
    });
    put(ceilingKey, ceiling);
  };
  save();
  const get = vi.fn(async (key: string, options?: R2GetOptions) => {
    const object = objects.get(key);
    if (!object) return null;
    const range =
      options?.range && "offset" in options.range ? options.range : undefined;
    const offset = range?.offset ?? 0,
      length = range?.length ?? object.raw.length;
    return {
      etag: object.etag,
      size: object.size,
      range: { offset, length },
      body: new Response(object.raw.subarray(offset, offset + length)).body,
      json: async () => JSON.parse(object.raw.toString()),
    };
  });
  return {
    blocks,
    indexes,
    manifests,
    segments,
    ceiling,
    save,
    objects,
    get,
    env: { METAGRAPH_ARCHIVE: { get } },
  };
}
beforeEach(() => resetModuleState());
afterEach(() => vi.restoreAllMocks());

test("native index census matches SQL physical counts and actual bounds across segments", async () => {
  for (const blocks of [
    [
      [2, 2, 5],
      [7, 8, 9],
    ],
    [[], [7, 9]],
    [[]],
  ]) {
    const f = fixture(blocks);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE blocks(block_number INTEGER)");
      const insert = db.prepare("INSERT INTO blocks VALUES(?)");
      for (const value of blocks.flat()) insert.run(value);
      const expected = {
        ...db
          .prepare(
            "SELECT MIN(block_number) lo,MAX(block_number) hi,COUNT(*) n FROM blocks",
          )
          .get()!,
      };
      assert.deepEqual(await loadIndexedBlockCensus(f.env), expected);
      assert.equal(f.get.mock.calls.length, 3 + blocks.length * 2);
      assert.ok(f.get.mock.calls.every(([key]) => key.endsWith(".json")));
    } finally {
      db.close();
    }
  }
});

test("selected corruption, incomplete source coverage and numeric overflow fail closed", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => {
      f.indexes[0].rows = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.ceiling.network = "testnet";
    },
    (f: ReturnType<typeof fixture>) => {
      f.ceiling.table = "extrinsics";
    },
    (f: ReturnType<typeof fixture>) => {
      f.ceiling.through = 10;
    },
    (f: ReturnType<typeof fixture>) => {
      f.segments[0].firstBlock = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.segments[0].lastBlock = 4;
      f.segments[1].firstBlock = 5;
    },
    (f: ReturnType<typeof fixture>) => {
      f.segments[0].lastBlock = 7;
      f.segments[1].firstBlock = 8;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    f.save();
    assert.equal(await loadIndexedBlockCensus(f.env), null);
  }
  for (const mode of [
    "size",
    "etag",
    "missing-index",
    "changed-index",
    "throws",
  ]) {
    const f = fixture();
    if (mode === "size") f.objects.get(ceilingKey)!.size = 8193;
    if (mode === "etag") f.objects.get(ceilingKey)!.etag = "";
    const index = `${base}/generations/${"1".repeat(64)}/blocks/index.json`;
    if (mode === "missing-index") f.objects.delete(index);
    if (mode === "changed-index") f.objects.get(index)!.etag = "changed";
    if (mode === "throws") f.get.mockRejectedValue(new Error("R2 unavailable"));
    assert.equal(await loadIndexedBlockCensus(f.env), null);
  }
  vi.spyOn(generations, "readHistoryBlockCensus").mockResolvedValue({
    lo: null,
    hi: null,
    n: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(await loadIndexedBlockCensus(fixture().env), null);
});

test("a moving source cannot certify a stale snapshot and missing ownership remains distinct", async () => {
  assert.equal(await loadIndexedBlockCensus(undefined), undefined);
  const f = fixture();
  f.objects.delete(ceilingKey);
  assert.equal(await loadIndexedBlockCensus(f.env), undefined);
  for (const mode of ["changed", "missing"]) {
    const g = fixture();
    const original = g.get.getMockImplementation()!;
    let seen = 0;
    g.get.mockImplementation(async (...args) => {
      if (args[0] === ceilingKey && ++seen === 2) {
        if (mode === "changed") g.objects.get(ceilingKey)!.etag = "changed";
        else g.objects.delete(ceilingKey);
      }
      return original(...args);
    });
    assert.equal(await loadIndexedBlockCensus(g.env), null);
  }
});

test("watchdog preserves gap reporting and never calls SQL for selected native proofs", async () => {
  const f = fixture();
  const query = vi.fn(async () => {
    throw Error("Selected census cannot query SQL");
  });
  const recordExceptionEvent = vi.fn(async () => true);
  const env = { ...f.env, ICEBERG_BLOCKS_MAX: "9" } as unknown as Env;
  const result = await runLakehouseSeamWatchdog(env, {
    query,
    recordExceptionEvent,
  });
  assert.equal(result.ok, true);
  assert.equal(result.contiguous, false);
  assert.ok(
    (result.reasons as string[]).some((reason) => reason.includes("holds 6")),
  );
  f.objects.get(ceilingKey)!.size = 8193;
  assert.equal(
    (await runLakehouseSeamWatchdog(env, { query, recordExceptionEvent }))
      .reason,
    "lakehouse_unavailable",
  );
  assert.equal(query.mock.calls.length, 0);
});
