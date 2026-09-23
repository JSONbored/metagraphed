import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  main,
  qualifyHistoryPublication,
} from "../../scripts/qualify-history-publication.ts";

function fixture(
  table: "blocks" | "chain_events" = "chain_events",
  empty = false,
) {
  const scope = {
    version: 1 as const,
    generation: "a".repeat(64),
    network: "testnet" as const,
    table,
  };
  const root = `metagraph/indexed-history/v1/testnet/${table}/generations/${scope.generation}`;
  const part = `metagraph/indexed-history/v1/testnet/${table}/${"b".repeat(64)}/00000-${"c".repeat(64)}.parquet`;
  const file = {
    ...scope,
    fileId: 0,
    sourceIdentity: "b".repeat(64),
    rows: 3,
    parts: [
      {
        key: part,
        etag: "part",
        bytes: 100,
        rowStart: 0,
        rows: 3,
        index: {
          key: part.replace(".parquet", ".page-index.json"),
          etag: "index",
          bytes: 80,
        },
      },
    ],
  };
  const index = {
    ...scope,
    state: "complete",
    rows: empty ? 0 : 3,
    runs: empty ? 0 : 1,
    shards: empty
      ? []
      : [
          {
            ...scope,
            prefix: "0000",
            key: `${root}/blocks/0000.bin`,
            etag: "shard",
            bytes: 24,
            runs: 1,
            rows: 3,
            firstBlock: 10,
            lastBlock: 10,
          },
        ],
  };
  const object = (key: string, input: unknown) => ({
    key,
    raw: JSON.stringify(input),
  });
  const descriptor = (input: { key: string; raw: string }) => ({
    key: input.key,
    etag: createHash("md5").update(input.raw).digest("hex"),
    bytes: Buffer.byteLength(input.raw),
  });
  const build = () => {
    const files = empty ? [] : [object(`${root}/files/00000.json`, file)];
    const blockIndex = object(`${root}/blocks/index.json`, index);
    const common = {
      ...scope,
      state: "complete",
      sourceSnapshot: "9007199254740993",
      rows: empty ? 0 : 3,
      files: files.map((item) => ({ ...descriptor(item), rows: file.rows })),
    };
    const blockManifest = object(`${root}/block-manifest.json`, {
      ...common,
      blockIndex: descriptor(blockIndex),
    });
    const hashManifest =
      table === "blocks"
        ? object(`${root}/manifest.json`, {
            ...common,
            shards: Array.from({ length: 4096 }, (_, i) => ({
              ...scope,
              prefix: i.toString(16).padStart(3, "0"),
              key: `${root}/hash/packed.bin`,
              etag: "hash",
              offset: i === 0 ? 0 : common.rows * 40,
              bytes: i === 0 ? common.rows * 40 : 0,
              rows: i === 0 ? common.rows : 0,
            })),
          })
        : undefined;
    const { version: _, ...segmentScope } = scope;
    const selection = {
      version: 2 as const,
      network: scope.network,
      table,
      segments: [
        {
          ...segmentScope,
          firstBlock: 10,
          lastBlock: 12,
          blockManifest: descriptor(blockManifest),
          ...(hashManifest ? { hashManifest: descriptor(hashManifest) } : {}),
        },
      ],
    };
    return {
      blockManifest,
      blockIndex,
      files,
      ...(hashManifest ? { hashManifest } : {}),
      selection,
    };
  };
  return { file, index, build, object, descriptor };
}

test("publication validates exact metadata bytes, packed hashes and empty ranges", () => {
  for (const table of ["blocks", "chain_events"] as const) {
    for (const empty of [false, true]) {
      const proof = qualifyHistoryPublication(fixture(table, empty).build());
      assert.equal(proof.rows, empty ? 0 : 3);
      assert.equal(proof.files, empty ? 0 : 1);
      assert.equal(proof.firstBlock, 10);
      assert.equal(proof.lastBlock, 12);
      assert.equal(Boolean(proof.hashManifest), table === "blocks");
    }
  }
});

test("publication rejects changed or missing objects before selection", () => {
  for (const mutate of [
    (x: ReturnType<ReturnType<typeof fixture>["build"]>) => {
      x.blockManifest.raw += " ";
    },
    (x: ReturnType<ReturnType<typeof fixture>["build"]>) => {
      x.blockIndex.raw += " ";
    },
    (x: ReturnType<ReturnType<typeof fixture>["build"]>) => {
      x.files[0].raw += " ";
    },
    (x: ReturnType<ReturnType<typeof fixture>["build"]>) => {
      x.files.pop();
    },
  ]) {
    const input = fixture().build();
    mutate(input);
    assert.throws(() => qualifyHistoryPublication(input), /Publication/);
  }
});

test("publication rejects wrong scope, physical row gaps and index range overflow", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.file.fileId = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.file.sourceIdentity = "d".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.file.parts[0].rowStart = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.file.parts[0].rows = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.file.parts[0].index.key += "x";
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.shards[0].lastBlock = 13;
    },
    (f: ReturnType<typeof fixture>) => {
      f.index.rows = 4;
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => qualifyHistoryPublication(f.build()));
  }
});

test("publication requires contiguous distinct selections and matching hash snapshots", () => {
  const f = fixture("blocks");
  for (const mutate of [
    (x: ReturnType<typeof f.build>) => {
      x.selection.segments[0].firstBlock = 13;
    },
    (x: ReturnType<typeof f.build>) => {
      x.selection.segments.push({ ...x.selection.segments[0] });
    },
    (x: ReturnType<typeof f.build>) => {
      delete x.hashManifest;
    },
    (x: ReturnType<typeof f.build>) => {
      const hash = JSON.parse(x.hashManifest!.raw);
      hash.sourceSnapshot = "123";
      x.hashManifest = f.object(x.hashManifest!.key, hash);
      x.selection.segments[0].hashManifest = f.descriptor(x.hashManifest);
    },
  ]) {
    const input = f.build();
    mutate(input);
    assert.throws(() => qualifyHistoryPublication(input), /Publication/);
  }
});

test("publication CLI is credential-free and rejects invalid argument counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "publication-proof-"));
  try {
    const path = join(directory, "input.json");
    const input = fixture().build();
    await writeFile(path, JSON.stringify(input));
    assert.deepEqual(
      JSON.parse(await main([path])),
      qualifyHistoryPublication(input),
    );
    await assert.rejects(main([]), /Usage/);
    await assert.rejects(main([path, path]), /Usage/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
