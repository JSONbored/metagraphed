import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  extrinsicSubnetIds,
  summarizeBlockEconomics,
} from "../src/block-economics.ts";
import {
  buildHistoryEconomicsAttribution,
  readHistoryEconomicsAttribution,
} from "../src/history-economics-attribution.ts";
import { historyJson, historySha256 } from "../src/history-sha256.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";
import { readHistoryBlock } from "../src/history-generation.ts";
import { HistoryBlockGenerationSchema } from "../schemas-src/artifacts/history-generation.ts";
import {
  main,
  prepareHistoryEconomics,
} from "../scripts/prepare-history-economics.ts";

const key = `metagraph/indexed-history/v1/testnet/extrinsics/${"a".repeat(64)}/00000-${"b".repeat(64)}.parquet`;
const part = { key, etag: "source", bytes: 100, rows: 2 };
function source(bytes: Uint8Array) {
  return {
    read: async (_key: string, _etag: string, offset: number, length: number) =>
      Uint8Array.from(bytes.subarray(offset, offset + length)).buffer,
  };
}
function object(value: unknown) {
  const bytes = new TextEncoder().encode(historyJson(value));
  return {
    bytes,
    descriptor: {
      key: key.replace(/\.parquet$/, `.economics-${historySha256(bytes)}.json`),
      etag: "companion",
      bytes: bytes.length,
    },
  };
}

test("compact attribution uses the canonical nested names, depth, Root and sorted uniqueness", async () => {
  const args = {
    irrelevant: 99,
    calls: [
      { name: "SRC_NETUID", value: "7" },
      { destination_netuid: 9 },
      { netuid: 0 },
      { netuid: 7 },
    ],
  };
  const ids = extrinsicSubnetIds(JSON.stringify(args));
  assert.deepEqual(ids, [0, 7, 9]);
  assert.deepEqual(extrinsicSubnetIds("malformed"), []);
  const built = buildHistoryEconomicsAttribution(part, [ids, []]);
  const descriptor = {
    key: built.key,
    etag: "companion",
    bytes: built.bytes.length,
  };
  const budget = parquetReadBudget();
  assert.deepEqual(
    await readHistoryEconomicsAttribution(
      source(built.bytes),
      descriptor,
      part,
      budget,
    ),
    [ids, []],
  );
  assert.equal(budget.requests, 1);
  assert.equal(budget.decodedBytes, built.bytes.length);
  assert.equal(budget.values, 5);
  assert.deepEqual(
    summarizeBlockEconomics([{ signer: null, call_args: args }], []),
    summarizeBlockEconomics([{ signer: null }], [], ids),
  );
  assert.throws(() => buildHistoryEconomicsAttribution(part, [ids]), /census/);
  assert.throws(
    () =>
      buildHistoryEconomicsAttribution({ ...part, key: "wrong" }, [ids, []]),
    /census/,
  );
  for (const invalid of [[9, 7], [7, 7], [-1], [Number.MAX_SAFE_INTEGER + 1]])
    assert.throws(() => buildHistoryEconomicsAttribution(part, [invalid, []]));
  assert.throws(
    () =>
      buildHistoryEconomicsAttribution(
        { ...part, rows: 65536 },
        Array.from({ length: 65536 }, () => [
          1000000, 2000000, 3000000, 4000000,
        ]),
      ),
    /size bound/,
  );
});

test("declared companion corruption, substitution and cumulative budgets fail closed", async () => {
  const built = object({ version: 1, source: part, subnetIds: [[0, 7], []] });
  for (const change of [
    { key: "foreign" },
    { key: key.replace(/\.parquet$/, ".economics-invalid.json") },
    { bytes: 2 * 1024 * 1024 + 1 },
  ])
    await assert.rejects(
      readHistoryEconomicsAttribution(
        source(built.bytes),
        { ...built.descriptor, ...change },
        part,
        parquetReadBudget(),
      ),
      /identity or size/,
    );
  await assert.rejects(
    readHistoryEconomicsAttribution(
      source(built.bytes),
      built.descriptor,
      { ...part, key: "wrong" },
      parquetReadBudget(),
    ),
    /identity or size/,
  );
  const changed = Uint8Array.from(built.bytes);
  changed[0] ^= 1;
  await assert.rejects(
    readHistoryEconomicsAttribution(
      source(changed),
      built.descriptor,
      part,
      parquetReadBudget(),
    ),
    /digest/,
  );
  for (const change of [
    { key: "foreign" },
    { etag: "wrong" },
    { bytes: 99 },
    { rows: 1 },
  ]) {
    const wrong = object({
      version: 1,
      source: { ...part, ...change },
      subnetIds: [[0, 7], []],
    });
    await assert.rejects(
      readHistoryEconomicsAttribution(
        source(wrong.bytes),
        wrong.descriptor,
        part,
        parquetReadBudget(),
      ),
      /census/,
    );
  }
  const short = object({ version: 1, source: part, subnetIds: [[0, 7]] });
  await assert.rejects(
    readHistoryEconomicsAttribution(
      source(short.bytes),
      short.descriptor,
      part,
      parquetReadBudget(),
    ),
    /census/,
  );
  const invalid = object({ version: 1, source: part, subnetIds: [[7, 0], []] });
  await assert.rejects(
    readHistoryEconomicsAttribution(
      source(invalid.bytes),
      invalid.descriptor,
      part,
      parquetReadBudget(),
    ),
    /sorted/,
  );
  for (const budget of [
    { ...parquetReadBudget(), decodedBytes: 32 * 1024 * 1024 },
    { ...parquetReadBudget(), values: 1_000_000 },
    parquetReadBudget(1),
  ])
    await assert.rejects(
      readHistoryEconomicsAttribution(
        source(built.bytes),
        built.descriptor,
        part,
        budget,
      ),
      /budget/,
    );
});

test("real wide Parquet preparation preserves attribution and avoids wide serving decode", async () => {
  const bytes = await readFile("tests/fixtures/parquet/economics-wide.parquet");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = {
    key: key.replace("b".repeat(64), sha256),
    etag: createHash("md5").update(bytes).digest("hex"),
    sha256,
    bytes: bytes.length,
    rows: 12,
  };
  const prepared = await prepareHistoryEconomics(bytes, identity);
  const scope = {
    network: "testnet" as const,
    table: "extrinsics" as const,
    generation: "c".repeat(64),
  };
  const root = `metagraph/indexed-history/v1/testnet/extrinsics/generations/${scope.generation}`;
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  function put(objectKey: string, value: unknown) {
    const raw =
      value instanceof Uint8Array
        ? value
        : new TextEncoder().encode(JSON.stringify(value));
    const etag = createHash("md5").update(raw).digest("hex");
    objects.set(objectKey, { bytes: raw, etag });
    return { key: objectKey, etag, bytes: raw.length };
  }
  put(identity.key, bytes);
  put(prepared.descriptor.key, prepared.bytes);
  const file = {
    version: 1,
    ...scope,
    fileId: 0,
    sourceIdentity: "a".repeat(64),
    rows: 12,
    parts: [
      {
        ...identity,
        sha256: undefined,
        rowStart: 0,
        index: put(
          identity.key.replace(/\.parquet$/, ".page-index.json"),
          prepared.index,
        ),
        economics: prepared.descriptor,
      },
    ],
  };
  const fileDescriptor = { ...put(`${root}/files/00000.json`, file), rows: 12 };
  const runs = new Uint8Array(24),
    view = new DataView(runs.buffer);
  view.setUint32(0, 42, true);
  view.setUint32(12, 12, true);
  view.setBigUint64(16, 10n, true);
  const shard = {
    version: 1,
    ...scope,
    ...put(`${root}/blocks/0000.bin`, runs),
    prefix: "0000",
    firstBlock: 42,
    lastBlock: 42,
    rows: 12,
    runs: 1,
  };
  const generation = HistoryBlockGenerationSchema.parse({
    version: 1,
    ...scope,
    state: "complete",
    sourceSnapshot: "1",
    rows: 12,
    files: [fileDescriptor],
    blockIndex: put(`${root}/blocks/index.json`, {
      version: 1,
      ...scope,
      state: "complete",
      rows: 12,
      runs: 1,
      shards: [shard],
    }),
  });
  const indexedSource = {
    async read(
      objectKey: string,
      etag: string,
      offset: number,
      length: number,
    ) {
      const value = objects.get(objectKey);
      if (!value || value.etag !== etag)
        throw new Error("Synthetic source missing or changed");
      return Uint8Array.from(value.bytes.subarray(offset, offset + length))
        .buffer;
    },
  };
  const rows = Array.from({ length: 12 }, () => [0, 7, 9]);
  assert.deepEqual(
    await readHistoryEconomicsAttribution(
      source(prepared.bytes),
      prepared.descriptor,
      identity,
      parquetReadBudget(),
    ),
    rows,
  );
  const fields = [
    "block_number",
    "observed_at",
    "signer",
    "fee_tao",
    "tip_tao",
  ];
  const measurements: {
    mode: string;
    elapsedMs: number;
    bytes: number;
    decodedBytes: number;
    requests: number;
  }[] = [];
  let canonical: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const compact of [false, true]) {
      const budget = parquetReadBudget();
      const started = performance.now();
      const selected = await readHistoryBlock(
        indexedSource,
        generation,
        scope,
        42,
        budget,
        [...fields, "call_args"],
        compact,
      );
      const ids = compact
        ? selected.flatMap((row) => row.__economics_subnet_ids as number[])
        : [];
      const result = summarizeBlockEconomics(
        selected.map((row) => ({
          ...row,
          fee_tao: String(row.fee_tao),
          tip_tao: String(row.tip_tao),
        })),
        [],
        ids,
      );
      if (!compact) {
        assert.ok((selected[0].call_args as string).length > 1024 * 1024);
        canonical = result;
      } else {
        assert.equal(Object.hasOwn(selected[0], "call_args"), false);
        assert.deepEqual(result, canonical);
        assert.deepEqual(result.subnet_ids, [0, 7, 9]);
        assert.equal(result.fee_tao, "1.5");
        assert.equal(result.tip_tao, "0.06");
        assert.ok(budget.decodedBytes < 10000);
      }
      measurements.push({
        mode: compact ? "compact" : "legacy",
        elapsedMs: performance.now() - started,
        bytes: budget.bytes,
        decodedBytes: budget.decodedBytes,
        requests: budget.requests,
      });
    }
  }
  console.log("SYNTHETIC_WIDE_ECONOMICS", JSON.stringify(measurements));
  await assert.rejects(
    readHistoryBlock(
      indexedSource,
      generation,
      { ...scope, table: "blocks" },
      42,
      parquetReadBudget(),
      fields,
      true,
    ),
    /extrinsic projection/,
  );
  await assert.rejects(
    readHistoryBlock(
      indexedSource,
      generation,
      scope,
      42,
      parquetReadBudget(),
      undefined,
      true,
    ),
    /extrinsic projection/,
  );
  // Old manifests remain readable through the ordinary projection. Full detail
  // ignores an optional companion even if that object subsequently goes missing.
  objects.delete(prepared.descriptor.key);
  assert.ok(
    (
      (
        await readHistoryBlock(
          indexedSource,
          generation,
          scope,
          42,
          parquetReadBudget(),
        )
      )[0].call_args as string
    ).length >
      1024 * 1024,
  );
  await assert.rejects(
    readHistoryBlock(
      indexedSource,
      generation,
      scope,
      42,
      parquetReadBudget(),
      [...fields, "call_args"],
      true,
    ),
    /missing or changed/,
  );
  delete (file.parts[0] as { economics?: unknown }).economics;
  generation.files[0] = { ...put(fileDescriptor.key, file), rows: 12 };
  assert.ok(
    (
      await readHistoryBlock(
        indexedSource,
        generation,
        scope,
        42,
        parquetReadBudget(),
        [...fields, "call_args"],
        true,
      )
    )[0].call_args,
  );
  for (const change of [
    { bytes: bytes.length + 1 },
    { etag: "0".repeat(32) },
    { sha256: "0".repeat(64) },
  ])
    await assert.rejects(
      prepareHistoryEconomics(bytes, { ...identity, ...change }),
      /identity mismatch/,
    );
  await assert.rejects(
    prepareHistoryEconomics(bytes, { ...identity, rows: 13 }),
    /census/,
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), "economics-preparation-"),
  );
  try {
    const input = path.join(directory, "part.parquet"),
      descriptor = path.join(directory, "identity.json"),
      output = path.join(directory, "output.json");
    await writeFile(input, bytes);
    await writeFile(descriptor, JSON.stringify(identity));
    assert.deepEqual(
      JSON.parse(await main([input, descriptor, output])),
      prepared.descriptor,
    );
    assert.deepEqual(await readFile(output), Buffer.from(prepared.bytes));
    await assert.rejects(main([input, descriptor, output]), /EEXIST/);
    await assert.rejects(main([]), /Usage/);
    await writeFile(input, bytes.subarray(1));
    await assert.rejects(main([input, descriptor, output]), /file size/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
