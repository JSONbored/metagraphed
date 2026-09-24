import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { loadIndexedRuntimeHistory } from "../src/indexed-runtime-history.ts";
import { readSelectedHistorySegments } from "../src/indexed-history-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { currentIndexedHistoryFailureGeneration } from "../src/indexed-history-status.ts";
import { loadRuntimeVersionHistoryColdTier } from "../src/runtime-versions-cold-tier.ts";
import { decodeWatermarkKey } from "../src/decode-watermark.ts";

const runtime = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('test'); } }",
  compatibilityDate: "2026-06-06",
  r2Buckets: ["ARCHIVE"],
});
let bucket: R2Bucket;
beforeAll(async () => {
  bucket = (await runtime.getR2Bucket("ARCHIVE")) as unknown as R2Bucket;
});
afterAll(async () => {
  await runtime.dispose();
});
beforeEach(() => {
  resetModuleState();
});
const current = "metagraph/indexed-history/v1/mainnet/blocks/current.json";
async function put(key: string, input: unknown) {
  const raw = JSON.stringify(input),
    object = await bucket.put(key, raw);
  assert.ok(object);
  return {
    key,
    etag: object.etag,
    bytes: new TextEncoder().encode(raw).length,
  };
}
async function fixture() {
  await put(decodeWatermarkKey("mainnet"), {
    decoded_through: 19,
    per_table: { blocks: 19 },
  });
  const segments = [],
    summaries = [];
  for (let i = 0; i < 2; i++) {
    const scope = {
      generation: String(i + 1).repeat(64),
      network: "mainnet" as const,
      table: "blocks" as const,
    };
    const root = `metagraph/indexed-history/v1/mainnet/blocks/generations/${scope.generation}`;
    const firstBlock = i * 10,
      lastBlock = firstBlock + 9;
    const manifest = {
      version: 1,
      ...scope,
      state: "complete",
      sourceSnapshot: String(i + 10),
      rows: 10,
      files: [
        { key: `${root}/files/00000.json`, etag: "file", bytes: 100, rows: 10 },
      ],
      blockIndex: {
        key: `${root}/blocks/index.json`,
        etag: "index",
        bytes: 100,
      },
    };
    const summary = {
      version: 1,
      ...scope,
      sourceSnapshot: manifest.sourceSnapshot,
      rows: 10,
      versionedRows: 10,
      transitions: [
        {
          spec_version: 1,
          block_number: firstBlock,
          observed_at: (100 + i) as number | null,
        },
        {
          spec_version: 2 + i,
          block_number: firstBlock + 1,
          observed_at: null as number | null,
        },
      ],
      latest: { spec_version: 1, block_number: lastBlock } as {
        spec_version: number;
        block_number: number;
      } | null,
    };
    const key = `${root}/runtime.json`;
    summaries.push({ key, value: summary });
    await put(key, summary);
    segments.push({
      ...scope,
      firstBlock,
      lastBlock,
      blockManifest: await put(`${root}/block-manifest.json`, manifest),
    });
  }
  await put(current, {
    version: 2,
    network: "mainnet",
    table: "blocks",
    segments,
  });
  return {
    env: {
      NATIVE_PROJECTIONS: "enabled",
      METAGRAPH_ARCHIVE: bucket,
      NATIVE_HISTORY_FIXTURE: undefined,
    },
    segments,
    summaries,
  };
}

test("runtime combines complete selected summaries and preserves rollback and independent minima", async () => {
  const f = await fixture();
  f.summaries[1].value.transitions = [
    { spec_version: 1, block_number: 10, observed_at: 90 },
    { spec_version: 2, block_number: 11, observed_at: 95 },
    { spec_version: 3, block_number: 12, observed_at: null },
  ];
  await put(f.summaries[1].key, f.summaries[1].value);
  const value = await loadRuntimeVersionHistoryColdTier(f.env);
  assert.ok(value);
  assert.equal(value.current_spec_version, 1);
  assert.equal(value.transitions.length, 3);
  assert.equal(value.transitions[0].block_number, 0);
  assert.equal(value.transitions[0].observed_at, new Date(90).toISOString());
  assert.equal(value.transitions[1].observed_at, new Date(95).toISOString());
  assert.equal(currentIndexedHistoryFailureGeneration(), 0);
  assert.equal(
    (await readSelectedHistorySegments(f.env, "blocks", "mainnet"))?.length,
    2,
  );
});

test("nullable timestamps and empty selected tails retain prior runtime truth", async () => {
  const f = await fixture();
  f.summaries[1].value.transitions = [
    { spec_version: 1, block_number: 10, observed_at: null },
    { spec_version: 2, block_number: 11, observed_at: null },
  ];
  await put(f.summaries[1].key, f.summaries[1].value);
  let value = await loadIndexedRuntimeHistory(f.env);
  assert.ok(value);
  assert.equal(value.transitions[0].observed_at, new Date(100).toISOString());
  assert.equal(value.transitions[1].observed_at, null);
  f.summaries[1].value.versionedRows = 0;
  f.summaries[1].value.transitions = [];
  f.summaries[1].value.latest = null;
  await put(f.summaries[1].key, f.summaries[1].value);
  value = await loadIndexedRuntimeHistory(f.env);
  assert.ok(value);
  assert.equal(value.current_spec_version, 1);
  f.summaries[0].value.versionedRows = 0;
  f.summaries[0].value.transitions = [];
  f.summaries[0].value.latest = null;
  await put(f.summaries[0].key, f.summaries[0].value);
  assert.equal(await loadIndexedRuntimeHistory(f.env), null);
});

test("equal first heights from repeated captures have deterministic version order", async () => {
  const f = await fixture();
  f.summaries[0].value.transitions = [
    { spec_version: 2, block_number: 0, observed_at: 100 },
    { spec_version: 1, block_number: 0, observed_at: 100 },
  ];
  await put(f.summaries[0].key, f.summaries[0].value);
  const value = await loadIndexedRuntimeHistory(f.env);
  assert.ok(value);
  assert.deepEqual(
    value.transitions.map((row) => row.spec_version),
    [1, 2, 3],
  );
  assert.equal(value.current_spec_version, 1);
});

test("absent selectors and summaries keep migration fallback without claiming absence", async () => {
  assert.equal(await loadIndexedRuntimeHistory(undefined), undefined);
  const f = await fixture();
  await bucket.delete(f.summaries[1].key);
  assert.equal(await loadIndexedRuntimeHistory(f.env), undefined);
  resetModuleState();
  await bucket.delete(current);
  assert.equal(await loadIndexedRuntimeHistory(f.env), undefined);
  assert.equal(currentIndexedHistoryFailureGeneration(), 0);
});

test("missing watermarks and publication lag retain migration fallback", async () => {
  const f = await fixture();
  for (const value of [
    null,
    { decoded_through: 19 },
    { decoded_through: 19, per_table: { blocks: 20 } },
  ]) {
    resetModuleState();
    await put(decodeWatermarkKey("mainnet"), value);
    assert.equal(await loadIndexedRuntimeHistory(f.env), undefined);
    assert.equal(currentIndexedHistoryFailureGeneration(), 0);
  }
});

test("runtime rejects every mismatched census, scope, duplicate and out-of-range transition", async () => {
  const mutations = [
    (x: Record<string, unknown>) => {
      x.network = "testnet";
    },
    (x: Record<string, unknown>) => {
      x.generation = "f".repeat(64);
    },
    (x: Record<string, unknown>) => {
      x.sourceSnapshot = "99";
    },
    (x: Record<string, unknown>) => {
      x.rows = 11;
    },
    (x: Record<string, unknown>) => {
      x.versionedRows = 11;
    },
    (x: Record<string, unknown>) => {
      x.versionedRows = 1;
    },
    (x: Record<string, unknown>) => {
      x.latest = null;
    },
    (x: Record<string, unknown>) => {
      x.transitions = [];
    },
    (x: Record<string, unknown>) => {
      x.transitions = [
        { spec_version: 1, block_number: 10, observed_at: 1 },
        { spec_version: 1, block_number: 11, observed_at: 2 },
      ];
    },
    (x: Record<string, unknown>) => {
      x.transitions = [
        { spec_version: 1, block_number: 11, observed_at: 1 },
        { spec_version: 2, block_number: 10, observed_at: 2 },
      ];
    },
    (x: Record<string, unknown>) => {
      x.transitions = [{ spec_version: 1, block_number: 9, observed_at: 1 }];
    },
    (x: Record<string, unknown>) => {
      x.transitions = [{ spec_version: 1, block_number: 20, observed_at: 1 }];
    },
    (x: Record<string, unknown>) => {
      x.latest = { spec_version: 99, block_number: 19 };
    },
    (x: Record<string, unknown>) => {
      x.latest = { spec_version: 1, block_number: 20 };
    },
    (x: Record<string, unknown>) => {
      x.latest = { spec_version: 1, block_number: 9 };
    },
    (x: Record<string, unknown>) => {
      x.latest = { spec_version: 1, block_number: 10 };
    },
  ];
  for (const mutate of mutations) {
    resetModuleState();
    const f = await fixture(),
      value = structuredClone(f.summaries[1].value);
    mutate(value);
    await put(f.summaries[1].key, value);
    assert.equal(await loadIndexedRuntimeHistory(f.env), null);
    assert.equal(currentIndexedHistoryFailureGeneration(), 1);
  }
});

test("oversized summaries and unreadable manifests fail without SQL fallback", async () => {
  const f = await fixture();
  await bucket.put(f.summaries[0].key, " ".repeat(1024 * 1024 + 1));
  assert.equal(await loadIndexedRuntimeHistory(f.env), null);
  resetModuleState();
  const clean = await fixture();
  await bucket.delete(clean.segments[0].blockManifest.key);
  const value = await loadRuntimeVersionHistoryColdTier(clean.env);
  assert.equal(value, null);
  assert.equal(currentIndexedHistoryFailureGeneration(), 1);
});

// A configured legacy credential must never revive the retired network reader.
const noWarehouse = vi.fn(async () => {
  throw Error("Unexpected network SQL");
});
beforeEach(() => {
  noWarehouse.mockClear();
  vi.stubGlobal("fetch", noWarehouse);
});
afterEach(() => {
  try {
    assert.equal(noWarehouse.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
  }
});
