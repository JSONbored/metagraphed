import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHistoryAssetMetadataReader } from "../src/history-asset-metadata.ts";
import { resetModuleState } from "../src/module-state-registry.ts";

beforeEach(resetModuleState);

describe("verified immutable asset metadata cache", () => {
  it("reuses completed bytes across requests while every buffer remains owned", async () => {
    const store = {},
      original = new Uint8Array([1, 2, 3]),
      load = vi.fn(async () => original),
      first = createHistoryAssetMetadataReader(store),
      second = createHistoryAssetMetadataReader(store);
    const value = await first("digest", 3, load);
    value.fill(8);
    original.fill(9);
    const cached = await second("digest", 3, load);
    expect(cached).toEqual(new Uint8Array([1, 2, 3]));
    cached.fill(7);
    expect(await second("digest", 3, load)).toEqual(new Uint8Array([1, 2, 3]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isolates stores even when their advertised content identities match", async () => {
    const load = vi.fn(async () => new Uint8Array([1]));
    await createHistoryAssetMetadataReader({})("digest", 1, load);
    await createHistoryAssetMetadataReader({})("digest", 1, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not share pending I/O between requests or double-count racing fills", async () => {
    const store = {},
      resolvers: ((value: Uint8Array) => void)[] = [],
      load = vi.fn(
        () => new Promise<Uint8Array>((resolve) => resolvers.push(resolve)),
      );
    const first = createHistoryAssetMetadataReader(store)("digest", 1, load),
      second = createHistoryAssetMetadataReader(store)("digest", 1, load);
    expect(load).toHaveBeenCalledTimes(2);
    resolvers[0](new Uint8Array([1]));
    resolvers[1](new Uint8Array([1]));
    const [a, b] = await Promise.all([first, second]);
    a.fill(9);
    expect(b).toEqual(new Uint8Array([1]));
    expect(
      await createHistoryAssetMetadataReader(store)("digest", 1, load),
    ).toEqual(new Uint8Array([1]));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("prevents a pending operation from repopulating reset state", async () => {
    const read = createHistoryAssetMetadataReader({});
    let resolve!: (value: Uint8Array) => void;
    const pending = read(
      "digest",
      1,
      () => new Promise((done) => (resolve = done)),
    );
    resetModuleState();
    resolve(new Uint8Array([1]));
    await pending;
    const load = vi.fn(async () => new Uint8Array([1]));
    await read("digest", 1, load);
    expect(load).toHaveBeenCalledTimes(1);
    resetModuleState();
    await read("digest", 1, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("rejects size conflicts and never retains failed verification", async () => {
    const read = createHistoryAssetMetadataReader({}),
      bad = vi.fn(async () => {
        throw new Error("Digest changed");
      });
    await expect(read("digest", 1, bad)).rejects.toThrow("Digest changed");
    await expect(
      read("digest", 2, async () => new Uint8Array([1])),
    ).rejects.toThrow("size conflict");
    await read("digest", 1, async () => new Uint8Array([1]));
    await expect(read("digest", 2, bad)).rejects.toThrow("size conflict");
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("does not admit objects over the metadata size bound", async () => {
    const read = createHistoryAssetMetadataReader({}),
      size = 512 * 1024 + 1,
      load = vi.fn(async () => new Uint8Array(size));
    await read("digest", size, load);
    await read("digest", size, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    { size: 512 * 1024, count: 8 },
    { size: 1, count: 128 },
  ])(
    "enforces the global byte and entry limits with LRU eviction: %j",
    async ({ size, count }) => {
      const read = createHistoryAssetMetadataReader({}),
        load = vi.fn(async () => new Uint8Array(size));
      for (let i = 0; i < count; i++) await read(String(i), size, load);
      await read("0", size, load);
      await read("new", size, load);
      await read("0", size, load);
      expect(load).toHaveBeenCalledTimes(count + 1);
      await read("1", size, load);
      expect(load).toHaveBeenCalledTimes(count + 2);
    },
  );
});
