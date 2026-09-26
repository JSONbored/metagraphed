import { describe, expect, it, vi } from "vitest";
import { CHAIN_FIREHOSE_TOPICS } from "../src/chain-firehose-topics.ts";
import { historyAssetSource } from "../src/history-asset-source.ts";
import {
  NATIVE_HISTORY_ASSET_OBJECT_KEY,
  NativeHistoryAssetReleaseSchema,
  NativeHistoryAssetShardSchema,
} from "../schemas-src/artifacts/native-history-assets.ts";
import { HistoryAssetShardSchema } from "../schemas-src/artifacts/history-assets.ts";
import {
  assetHash,
  assetKey,
  historyAssetsFixture,
} from "./history-assets-fixture.ts";

const root = `metagraph/indexed-history/v1/mainnet/extrinsics/`;
const generation = `${root}generations/${"a".repeat(64)}/`;
const key = `${generation}hash/000.bin`;
const etag = "b".repeat(32);
const fallback = () => ({
  read: vi.fn(async () => new Uint8Array([99]).buffer),
});
function nativeFixture(raw = new Uint8Array([1, 2, 3])) {
  const f = historyAssetsFixture([{ key, etag, chunks: [raw] }]);
  f.root.prefixes = [root];
  f.publish();
  const env = () => ({
    NATIVE_HISTORY_ASSETS: f.env.HISTORY_ASSETS,
    NATIVE_HISTORY_ASSET_RELEASE: f.env.HISTORY_ASSET_RELEASE,
  });
  return { ...f, nativeEnv: env };
}

describe("native immutable history asset boundaries", () => {
  it("admits only immutable native objects across both networks and every decoded table", () => {
    for (const network of ["mainnet", "testnet"]) {
      for (const table of CHAIN_FIREHOSE_TOPICS) {
        const base = `metagraph/indexed-history/v1/${network}/${table}/`;
        for (const suffix of [
          `generations/${"a".repeat(64)}/block-manifest.json`,
          `generations/${"a".repeat(64)}/manifest.json`,
          `generations/${"a".repeat(64)}/files/00000.json`,
          `generations/${"a".repeat(64)}/hash/abc.bin`,
          `generations/${"a".repeat(64)}/hash/packed.bin`,
          `generations/${"a".repeat(64)}/blocks/index.json`,
          `generations/${"a".repeat(64)}/blocks/00ab.bin`,
          `${"b".repeat(64)}/00000-${"c".repeat(64)}.parquet`,
          `${"b".repeat(64)}/00000-${"c".repeat(64)}.page-index.json`,
        ])
          expect(NATIVE_HISTORY_ASSET_OBJECT_KEY.test(base + suffix)).toBe(
            true,
          );
      }
    }
    for (const invalid of [
      root + "current.json",
      root + "source-ceiling.json",
      generation + "runtime.json",
      generation + "../manifest.json",
      generation + "files/00000xjson",
      generation + "hash/xyz.bin",
      generation + "blocks/abc.bin",
      generation.replace("mainnet", "other") + "manifest.json",
      generation.replace("extrinsics", "other") + "manifest.json",
      assetKey("feed"),
    ])
      expect(NATIVE_HISTORY_ASSET_OBJECT_KEY.test(invalid)).toBe(false);
  });

  it("isolates native bindings and preserves exact ranges and the original ETag", async () => {
    const f = nativeFixture(),
      r2 = fallback();
    const source = historyAssetSource(
      {
        ...f.nativeEnv(),
        HISTORY_ASSET_RELEASE: "invalid-feed-release",
      },
      r2,
      "NATIVE_HISTORY",
    );
    expect(new Uint8Array(await source.read(key, etag, 1, 2))).toEqual(
      new Uint8Array([2, 3]),
    );
    expect(r2.read).not.toHaveBeenCalled();
    await expect(source.read(key, "c".repeat(32), 0, 1)).rejects.toThrow(
      "original identity",
    );
    await expect(source.read(key, etag, 2, 2)).rejects.toThrow(
      "original identity",
    );
    await source.read(root + "current.json", etag, 0, 1);
    expect(r2.read).toHaveBeenCalledExactlyOnceWith(
      root + "current.json",
      etag,
      0,
      1,
    );
  });

  it("retains the original reader until native assets are configured and for unmapped objects", async () => {
    const f = nativeFixture(),
      r2 = fallback();
    expect(historyAssetSource(f.env, r2, "NATIVE_HISTORY")).toBe(r2);
    const source = historyAssetSource(f.nativeEnv(), r2, "NATIVE_HISTORY");
    const absent = key.replace("000.bin", "001.bin");
    await source.read(absent, etag, 0, 1);
    expect(r2.read).toHaveBeenCalledExactlyOnceWith(absent, etag, 0, 1);
  });

  it("maps a 128 MiB native file while reading only its requested final bytes", async () => {
    const raw = new Uint8Array(128 * 1024).fill(42);
    const f = nativeFixture(raw),
      r2 = fallback();
    const object = Object.values(f.shards)[0].objects[assetHash(key)];
    object.chunks = Array(1024).fill(object.chunks[0]);
    object.bytes = 128 * 1024 * 1024;
    f.publish();
    const source = historyAssetSource(f.nativeEnv(), r2, "NATIVE_HISTORY");
    expect(
      new Uint8Array(await source.read(key, etag, object.bytes - 2, 2)),
    ).toEqual(new Uint8Array([42, 42]));
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(r2.read).not.toHaveBeenCalled();
    expect(() =>
      NativeHistoryAssetShardSchema.parse({
        version: 1,
        objects: { [assetHash(key)]: { ...object, bytes: object.bytes + 1 } },
      }),
    ).toThrow();
    expect(() =>
      HistoryAssetShardSchema.parse({
        version: 1,
        objects: { [assetHash(key)]: { ...object, key: assetKey("feed") } },
      }),
    ).toThrow();
  });

  it("supports the native 32 MiB metadata limit without widening the feed range limit", async () => {
    const raw = new Uint8Array(128 * 1024).fill(7);
    const f = nativeFixture(raw),
      r2 = fallback();
    const object = Object.values(f.shards)[0].objects[assetHash(key)];
    object.chunks = Array(256).fill(object.chunks[0]);
    object.bytes = 32 * 1024 * 1024;
    f.publish();
    const source = historyAssetSource(f.nativeEnv(), r2, "NATIVE_HISTORY");
    const result = new Uint8Array(
      await source.read(key, etag, 0, object.bytes),
    );
    expect(result.length).toBe(object.bytes);
    expect(result[0]).toBe(7);
    expect(result.at(-1)).toBe(7);
    await expect(source.read(key, etag, 0, object.bytes + 1)).rejects.toThrow(
      "Invalid immutable history asset range",
    );
    await expect(
      historyAssetSource(f.env, r2).read(
        assetKey("feed"),
        etag,
        0,
        16 * 1024 * 1024 + 1,
      ),
    ).rejects.toThrow("Invalid immutable history asset range");
    expect(r2.read).not.toHaveBeenCalled();
  });

  it("validates native catalog scope and shard widths", () => {
    const f = nativeFixture();
    expect(NativeHistoryAssetReleaseSchema.parse(f.root)).toEqual(f.root);
    for (const prefixes of [
      ["metagraph/"],
      [generation],
      [root.replace("mainnet", "other")],
      Array(9).fill(root),
    ]) {
      expect(() =>
        NativeHistoryAssetReleaseSchema.parse({ ...f.root, prefixes }),
      ).toThrow();
    }
    const ref = Object.values(f.root.shards)[0];
    expect(() =>
      NativeHistoryAssetReleaseSchema.parse({
        ...f.root,
        shards: { abc: ref },
      }),
    ).toThrow();
    expect(
      NativeHistoryAssetReleaseSchema.parse({
        ...f.root,
        shardPrefixLength: 3,
        shards: { abc: ref },
      }).shardPrefixLength,
    ).toBe(3);
  });
});
