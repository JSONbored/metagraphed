import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgRetainedBlocks } from "../src/retained-blocks-pg.ts";
import type { PgTransaction, PgTransactionOptions } from "../src/pg-pool.ts";
import {
  handleRetainedBlocksSync,
  retainedBlockDigest,
  type RetainedBlocksSyncInput,
} from "../src/retained-blocks-sync.ts";
import {
  readRetainedBlockCensus,
  readRetainedBlockObservedAt,
  readRetainedBlockRows,
} from "../src/retained-blocks-d1.ts";
import { hasRetainedHistoryStore } from "../src/retained-history-store.ts";

const now = 1000;
const identity = "a".repeat(64);
const state = {
  network: 0,
  generation: identity,
  table_uuid: "019fc234-642e-7f82-b656-ddb8529315ab",
  snapshot: "1",
  sequence: 1,
  generated_at: now,
  source_rows: 2,
  source_files: 1,
  coverage: null,
};
const source = {
  id: 1,
  network: 0,
  source: "descriptor",
  expected_rows: 2,
  received_rows: 0,
};
const row = [1, "hash", null, null, 2, 3, 4, 5] as [
  number,
  string,
  null,
  null,
  number,
  number,
  number,
  number,
];
const publish: RetainedBlocksSyncInput = {
  kind: "publish",
  network: "mainnet",
  table_uuid: state.table_uuid,
  snapshot: "1",
  sequence: 1,
  generated_at: now,
  source_rows: 2,
  sources: [identity],
  coverage: null,
};

function fixture(answers: unknown[] = [], rows: unknown[] = []) {
  const calls: { kind: string; text: string; values: unknown[] }[] = [];
  let options: PgTransactionOptions | undefined;
  const next = () => {
    const value = answers.shift();
    if (value instanceof Error) throw value;
    return value ?? null;
  };
  const tx: PgTransaction = {
    async query<Row>(text: string, values: unknown[] = []) {
      calls.push({ kind: "query", text, values });
      return (text.includes("pg_advisory") ? [] : rows) as Row[];
    },
    async first<Row>(text: string, values: unknown[] = []) {
      calls.push({ kind: "first", text, values });
      return next() as Row | null;
    },
    async run(text: string, values: unknown[] = []) {
      calls.push({ kind: "run", text, values });
      return { changes: 1 };
    },
  };
  const store = createPgRetainedBlocks({
    async transaction<T>(
      callback: (transaction: PgTransaction) => Promise<T>,
      selected?: PgTransactionOptions,
    ) {
      options = selected;
      return callback(tx);
    },
  });
  return { store, calls, options: () => options };
}

test("begin preserves source identity and reports the existing offset", async () => {
  const descriptor = {
    network: "mainnet",
    table: "blocks",
    bucket: "fixture",
    key: "k",
    etag: "e",
    bytes: 1,
    rows: 2,
  } as const;
  const input = { kind: "begin", identity, source: descriptor } as const;
  const good = fixture([
    { ...source, source: JSON.stringify(descriptor), received_rows: 1 },
  ]);
  assert.deepEqual(await (await good.store.sync(input, now)).json(), {
    received_rows: 1,
    expected_rows: 2,
  });
  assert.equal(good.options(), undefined);
  assert.equal((await fixture([source]).store.sync(input, now)).status, 409);
});

test("chunk gates missing, skipped, excessive and conflicting replay inputs", async () => {
  const input: RetainedBlocksSyncInput = {
    kind: "chunk",
    identity,
    start: 0,
    rows: [row],
  };
  assert.equal((await fixture().store.sync(input, now)).status, 404);
  assert.equal(
    (await fixture([source]).store.sync({ ...input, start: 1 }, now)).status,
    409,
  );
  assert.equal(
    (await fixture([{ ...source, expected_rows: 0 }]).store.sync(input, now))
      .status,
    409,
  );
  const replay = { ...source, received_rows: 1 };
  const digest = retainedBlockDigest(input.rows);
  assert.equal(
    (await fixture([replay, { rows: 1, digest }]).store.sync(input, now))
      .status,
    200,
  );
  assert.equal(
    (await fixture([replay, null]).store.sync(input, now)).status,
    409,
  );
  assert.equal(
    (await fixture([replay, { rows: 2, digest }]).store.sync(input, now))
      .status,
    409,
  );
  assert.equal(
    (
      await fixture([replay, { rows: 1, digest: "changed" }]).store.sync(
        input,
        now,
      )
    ).status,
    409,
  );
});

test("chunk uses a source row lock and writes physical ordinals, histograms and receipt together", async () => {
  const f = fixture([source]);
  const response = await f.store.sync(
    { kind: "chunk", identity, start: 0, rows: [row] },
    now,
  );
  assert.deepEqual(await response.json(), { received_rows: 1 });
  assert.match(f.calls[0].text, /FOR UPDATE$/);
  assert.ok(f.calls.some((call) => call.text.includes("WITH ORDINALITY")));
  assert.ok(f.calls.some((call) => call.text.includes("ordinality-1")));
  assert.equal(
    f.calls.filter((call) =>
      call.text.includes("INSERT INTO retained.history_block_source_counts"),
    ).length,
    2,
  );
  assert.deepEqual(f.calls.at(-1)?.values, [1, 1]);
});

test("publication validates freshness and complete source census before mutations", async () => {
  for (const input of [
    { ...publish, sources: [identity, identity] },
    { ...publish, generated_at: now + 1 },
    { ...publish, generated_at: now - 7200001 },
  ]) {
    assert.equal((await fixture().store.sync(input, now)).status, 400);
  }
  for (const counts of [
    { files: 0, rows: 2 },
    { files: 1, rows: 1 },
  ]) {
    const f = fixture([counts]);
    assert.equal((await f.store.sync(publish, now)).status, 409);
    assert.equal(
      f.calls.some((call) => call.kind === "run"),
      false,
    );
  }
  for (const prior of [
    { ...state, sequence: 2 },
    { ...state, generated_at: now + 1 },
    { ...state, table_uuid: "different" },
    { ...state, snapshot: "different" },
  ]) {
    assert.equal(
      (await fixture([{ files: 1, rows: 2 }, prior]).store.sync(publish, now))
        .status,
      409,
    );
  }
});

test("publication locks the network including its initially empty state and emits the shared generation", async () => {
  for (const prior of [null, { ...state, sequence: 0 }]) {
    const f = fixture([{ files: 1, rows: 2 }, prior]);
    const result = await (await f.store.sync(publish, now)).json();
    assert.deepEqual(result, {
      generation: retainedBlockDigest(publish),
      source_rows: 2,
      source_files: 1,
    });
    assert.match(f.calls[0].text, /pg_advisory_xact_lock/);
    assert.deepEqual(f.calls[0].values, [0]);
    assert.ok(f.calls.some((call) => call.text.includes("FOR UPDATE")));
    assert.equal(f.calls.filter((call) => call.kind === "run").length, 4);
  }
});

test("status uses repeatable read, generation guards and bounded continuation", async () => {
  assert.deepEqual(
    await (
      await fixture().store.sync(
        { kind: "status", network: "mainnet", after: 0 },
        now,
      )
    ).json(),
    { state: null, sources: [], next_cursor: null },
  );
  assert.equal(
    (
      await fixture([state]).store.sync(
        { kind: "status", network: "mainnet", generation: "changed", after: 0 },
        now,
      )
    ).status,
    409,
  );
  const rows = Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }));
  const f = fixture([state], rows);
  const response = await f.store.sync(
    { kind: "status", network: "mainnet", generation: identity, after: 0 },
    now,
  );
  const data = (await response.json()) as {
    sources: unknown[];
    next_cursor: number;
  };
  assert.equal(data.sources.length, 200);
  assert.equal(data.next_cursor, 200);
  assert.deepEqual(f.options(), { isolation: "repeatable read" });
  const testnet = fixture();
  await testnet.store.sync(
    { kind: "status", network: "testnet", after: 0 },
    now,
  );
  assert.deepEqual(testnet.calls[0].values, [1]);
});

test("census binds source totals and indexed height boundaries to one snapshot", async () => {
  const f = fixture([
    state,
    { files: 1, rows: 2, pending: 0 },
    { block_number: 1 },
    { block_number: 2 },
  ]);
  assert.deepEqual(await f.store.census("mainnet", now), {
    lo: 1,
    hi: 2,
    n: 2,
  });
  assert.deepEqual(f.options(), { isolation: "repeatable read" });
  for (const counts of [
    { files: 1, rows: 2, pending: 1 },
    { files: 0, rows: 2, pending: 0 },
    { files: 1, rows: 1, pending: 0 },
  ]) {
    assert.equal(
      await fixture([state, counts, null, null]).store.census("mainnet", now),
      null,
    );
  }
  const empty = { ...state, source_rows: 0, source_files: 0 };
  assert.deepEqual(
    await fixture([
      empty,
      { files: 0, rows: 0, pending: 0 },
      null,
      null,
    ]).store.census("mainnet", now),
    { lo: null, hi: null, n: 0 },
  );
  assert.equal(
    await fixture([
      empty,
      { files: 0, rows: 0, pending: 0 },
      { block_number: 1 },
      null,
    ]).store.census("mainnet", now),
    null,
  );
  for (const bounds of [
    [null, { block_number: 2 }],
    [{ block_number: 1 }, null],
    [{ block_number: 2 }, { block_number: 1 }],
  ]) {
    assert.equal(
      await fixture([
        state,
        { files: 1, rows: 2, pending: 0 },
        ...bounds,
      ]).store.census("mainnet", now),
      null,
    );
  }
});

test("observed time and feeds preserve validation, nullable fields and physical cursor identity", async () => {
  assert.equal(
    await fixture([state, { observed_at: 5 }]).store.observedAt(
      1,
      "mainnet",
      now,
    ),
    new Date(5).toISOString(),
  );
  await assert.rejects(
    fixture([state, { observed_at: null }]).store.observedAt(1, "mainnet", now),
  );
  const block = {
    block_number: 1,
    block_hash: null,
    parent_hash: null,
    author: null,
    extrinsic_count: null,
    event_count: null,
    spec_version: null,
    observed_at: null,
  };
  const plain = fixture([state], [block]);
  assert.deepEqual(await plain.store.rows([], 2, "mainnet", now, {}), [block]);
  const detailed = fixture(
    [state, { matches: 1 }, { matches: 1 }],
    [{ ...block, _source_id: 1, _ordinal: 0 }],
  );
  assert.equal(
    (
      await detailed.store.rows(["block_number >= 1"], 2, "mainnet", now, {
        heightOrder: true,
        heightUpper: 9,
        minEvents: 1,
        minExtrinsics: 2,
      })
    )?.length,
    1,
  );
  assert.deepEqual(detailed.calls.at(-1)?.values, [0, 9, 2]);
  assert.match(detailed.calls.at(-1)!.text, /DESC NULLS LAST/);
  assert.deepEqual(
    await fixture([state, { matches: 0 }]).store.rows([], 2, "mainnet", now, {
      minEvents: 1,
    }),
    [],
  );
  await assert.rejects(
    fixture([{ ...state, generated_at: now + 1 }]).store.rows(
      [],
      2,
      "mainnet",
      now,
      {},
    ),
  );
});

test("existing entry points route an explicit store and retain unavailable responses", async () => {
  const f = fixture([
    state,
    { files: 1, rows: 2, pending: 0 },
    { block_number: 1 },
    { block_number: 2 },
    state,
    { observed_at: 5 },
    state,
  ]);
  const env = {
    RETAINED_BLOCKS_STORE: f.store,
    RETAINED_BLOCKS_NETWORKS: "mainnet",
    RETAINED_BLOCKS_SYNC_SECRET: "test",
  };
  assert.equal(hasRetainedHistoryStore(env), true);
  assert.deepEqual(await readRetainedBlockCensus(env, "mainnet", now), {
    lo: 1,
    hi: 2,
    n: 2,
  });
  assert.equal(
    await readRetainedBlockObservedAt(env, 1, "mainnet", now),
    new Date(5).toISOString(),
  );
  assert.deepEqual(await readRetainedBlockRows(env, [], 2, "mainnet", now), []);
  const request = () =>
    new Request("https://example.com/api/v1/internal/retained-blocks-sync", {
      method: "POST",
      headers: { "x-retained-blocks-sync-token": "test" },
      body: JSON.stringify({ kind: "status", network: "mainnet" }),
    });
  assert.equal(
    (await handleRetainedBlocksSync(request(), env, now)).status,
    200,
  );
  const unavailable = {
    ...env,
    RETAINED_BLOCKS_STORE: fixture([new Error("unavailable")]).store,
  };
  assert.equal(
    await readRetainedBlockCensus(unavailable, "mainnet", now),
    null,
  );
  assert.equal(
    await readRetainedBlockObservedAt(unavailable, 1, "mainnet", now),
    null,
  );
  assert.equal(
    await readRetainedBlockRows(unavailable, [], 2, "mainnet", now),
    null,
  );
  const failed = {
    ...env,
    RETAINED_BLOCKS_STORE: fixture([new Error("unavailable")]).store,
  };
  assert.equal(
    (await handleRetainedBlocksSync(request(), failed, now)).status,
    503,
  );
});
