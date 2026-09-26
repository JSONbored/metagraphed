import { describe, expect, it, vi } from "vitest";
import { historyAssetSource } from "../src/history-asset-source.ts";
import {
  assetHash,
  assetKey,
  historyAssetsFixture,
} from "./history-assets-fixture.ts";

const etag = "b".repeat(32),
  key = assetKey("first");
const input = () => ({
  key,
  etag,
  chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
});
const fallback = () => ({
  read: vi.fn(async () => new Uint8Array([99]).buffer),
});
const setup = () => {
  const assets = historyAssetsFixture([input()]),
    r2 = fallback();
  return { ...assets, r2, source: historyAssetSource(assets.env, r2) };
};

const partitioned = () => {
  const f = setup(),
    bindings: Record<string, { fetch: typeof f.fetch }> = {};
  f.root.partitionCount = 16;
  for (let i = 0; i < 16; i++) {
    const prefix = i.toString(16);
    bindings[`HISTORY_ASSETS_${prefix}`] = {
      fetch: vi.fn(async (request: Request) => {
        expect(new URL(request.url).pathname[1]).toBe(prefix);
        return f.fetch(request);
      }),
    };
  }
  f.publish();
  return { ...f, bindings, env: Object.assign(f.env, bindings) };
};

describe("immutable history asset ranges", () => {
  it("reuses verified catalog metadata across requests while payload reads stay bounded", async () => {
    const packKey = key.replace(".json", ".bin"),
      f = historyAssetsFixture([{ ...input(), key: packKey }]),
      r2 = fallback();
    await historyAssetSource(f.env, r2).read(packKey, etag, 0, 6);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    await historyAssetSource(f.env, r2).read(packKey, etag, 0, 6);
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect(r2.read).not.toHaveBeenCalled();
  });

  it("reuses relocated immutable JSON bytes across requests", async () => {
    const nodeKey = key.replace(/\.[^.]+$/, ".json"),
      f = historyAssetsFixture([{ ...input(), key: nodeKey }]),
      r2 = fallback();
    await historyAssetSource(f.env, r2).read(nodeKey, etag, 0, 6);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    await historyAssetSource(f.env, r2).read(nodeKey, etag, 0, 6);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(r2.read).not.toHaveBeenCalled();
  });

  it("reads a fully populated three-digit catalog within the metadata bound", async () => {
    const f = historyAssetsFixture([input()], 3),
      r2 = fallback(),
      ref = Object.values(f.root.shards)[0];
    for (let i = 0; i < 4096; i++)
      f.root.shards[i.toString(16).padStart(3, "0")] = ref;
    f.publishRoot(f.root);
    const bytes = Number(f.env.HISTORY_ASSET_RELEASE.split(":")[1]);
    expect(bytes).toBeGreaterThan(128 * 1024);
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(
      new Uint8Array(await historyAssetSource(f.env, r2).read(key, etag, 2, 3)),
    ).toEqual(new Uint8Array([3, 4, 5]));
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(r2.read).not.toHaveBeenCalled();
  });
  it.each([
    { declared: undefined, prefix: "abc" },
    { declared: 3, prefix: "ab" },
    { declared: 3, prefix: "a" },
    { declared: 3, prefix: "abcd" },
    { declared: 2, prefix: "ab" },
    { declared: 4, prefix: "abcd" },
  ])(
    "rejects inconsistent shard widths before reading payloads: %j",
    async ({ declared, prefix }) => {
      const f = setup();
      f.publishRoot({
        ...f.root,
        ...(declared === undefined ? {} : { shardPrefixLength: declared }),
        shards: { [prefix]: Object.values(f.root.shards)[0] },
      });
      await expect(
        historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ).rejects.toThrow();
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.r2.read).not.toHaveBeenCalled();
    },
  );
  it("serves account history from separate pinned stores without consulting transaction stores", async () => {
    const accountKey = key
      .replace("/extrinsics/", "/account_events/")
      .replace("/feeds/", "/accounts/");
    const f = historyAssetsFixture([{ ...input(), key: accountKey }]);
    f.root.partitionCount = 16;
    f.root.prefixes = [accountKey.slice(0, accountKey.indexOf("directory/"))];
    f.publish();
    const wrongStore = {
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
    };
    const env = {
      HISTORY_ASSETS: wrongStore,
      HISTORY_ASSET_RELEASE: "invalid-transaction-release",
      ACCOUNT_HISTORY_ASSETS: f.env.HISTORY_ASSETS,
      ACCOUNT_HISTORY_ASSET_RELEASE: f.env.HISTORY_ASSET_RELEASE,
      ...Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          `ACCOUNT_HISTORY_ASSETS_${i.toString(16)}`,
          { fetch: f.fetch },
        ]),
      ),
    };
    const r2 = fallback(),
      source = historyAssetSource(env, r2, "ACCOUNT_HISTORY");
    expect(new Uint8Array(await source.read(accountKey, etag, 2, 3))).toEqual(
      new Uint8Array([3, 4, 5]),
    );
    expect(r2.read).not.toHaveBeenCalled();
    expect(wrongStore.fetch).not.toHaveBeenCalled();
    await source.read(key, etag, 0, 1);
    expect(r2.read).toHaveBeenCalledExactlyOnceWith(key, etag, 0, 1);
  });
  it("leaves account reads on their exact R2 source until their own release is configured", () => {
    const f = setup();
    expect(historyAssetSource(f.env, f.r2, "ACCOUNT_HISTORY")).toBe(f.r2);
  });
  it("reads exact ranges when any declared generation prefix matches", async () => {
    const f = partitioned(),
      prefix = key.slice(0, key.indexOf("directory/"));
    f.root.prefixes = [prefix.replace("mainnet", "testnet"), prefix];
    f.publish();
    const source = historyAssetSource(f.env, f.r2);
    expect(new Uint8Array(await source.read(key, etag, 2, 3))).toEqual(
      new Uint8Array([3, 4, 5]),
    );
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.r2.read).not.toHaveBeenCalled();
  });
  it("skips metadata shards and payloads outside a release's generation scope", async () => {
    const f = partitioned();
    f.root.prefixes = [key.slice(0, key.indexOf("directory/"))];
    // Even a referenced shard is irrelevant outside the declared scope.
    const ref = Object.values(f.root.shards)[0];
    for (let i = 0; i < 256; i++)
      f.root.shards[i.toString(16).padStart(2, "0")] = ref;
    for (const ref of Object.values(f.root.shards)) f.files.delete(ref.sha256);
    f.publishRoot(f.root);
    const source = historyAssetSource(f.env, f.r2);
    for (const other of [
      key.replace("mainnet", "testnet"),
      key.replace("a".repeat(64), "c".repeat(64)),
    ]) {
      expect(new Uint8Array(await source.read(other, etag, 2, 3))).toEqual(
        new Uint8Array([99]),
      );
      expect(f.r2.read).toHaveBeenLastCalledWith(other, etag, 2, 3);
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(
      Object.values(f.bindings).every((b) => b.fetch.mock.calls.length === 0),
    ).toBe(true);
  });
  it.each(
    [
      [],
      ["metagraph/"],
      [key],
      [key.slice(0, key.indexOf("directory/") - 1)],
      [key.slice(0, key.indexOf("directory/")).replace("extrinsics", "blocks")],
      [
        key
          .slice(0, key.indexOf("directory/"))
          .replace("extrinsics", "account_events"),
      ],
      Array(65).fill(key.slice(0, key.indexOf("directory/"))),
    ].map((prefixes) => ({ prefixes })),
  )(
    "rejects malformed generation scopes before fallback: $prefixes",
    async ({ prefixes }) => {
      const f = setup();
      f.publishRoot({ ...f.root, prefixes });
      await expect(
        historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ).rejects.toThrow();
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.r2.read).not.toHaveBeenCalled();
    },
  );
  it("routes small payload chunks by digest while metadata stays in the root store", async () => {
    const f = partitioned(),
      source = historyAssetSource(f.env, f.r2);
    expect(new Uint8Array(await source.read(key, etag, 2, 3))).toEqual(
      new Uint8Array([3, 4, 5]),
    );
    expect(
      Object.values(f.bindings).reduce(
        (n, b) => n + b.fetch.mock.calls.length,
        0,
      ),
    ).toBe(2);
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.r2.read).not.toHaveBeenCalled();
    await source.read(key, etag, 0, 6);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it.each([undefined, null, {}, { fetch: "invalid" }])(
    "rejects a missing or malformed partition before any payload read: %j",
    async (binding) => {
      const f = partitioned();
      await expect(
        historyAssetSource({ ...f.env, HISTORY_ASSETS_f: binding }, f.r2).read(
          key,
          etag,
          0,
          1,
        ),
      ).rejects.toThrow(/partitions/);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.r2.read).not.toHaveBeenCalled();
    },
  );
  it("keeps unmapped keys on R2 with a partitioned release", async () => {
    const f = partitioned();
    f.shards[assetHash(key).slice(0, 2)].objects = {};
    f.publish();
    await historyAssetSource({ ...f.env, ...f.bindings }, f.r2).read(
      key,
      etag,
      0,
      1,
    );
    expect(f.r2.read).toHaveBeenCalledTimes(1);
  });
  it("refuses partitioned payload chunks larger than 128 KiB", async () => {
    const f = partitioned(),
      object = f.shards[assetHash(key).slice(0, 2)].objects[assetHash(key)];
    object.chunks[0].bytes = 128 * 1024 + 1;
    f.publish();
    await expect(
      historyAssetSource({ ...f.env, ...f.bindings }, f.r2).read(
        key,
        etag,
        0,
        1,
      ),
    ).rejects.toThrow(/chunk exceeds/);
  });
  it.each([0, 1, 8, 32, "16"])(
    "refuses unsupported partition counts %j",
    async (partitionCount) => {
      const f = setup();
      f.publishRoot({ ...f.root, partitionCount });
      await expect(
        historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ).rejects.toThrow();
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("allows bounded high-fanout reads while retaining a hard partition request ceiling", async () => {
    const inputs = Array.from({ length: 300 }, (_, i) => ({
      key: assetKey(`partition-object-${i}`),
      etag,
      chunks: [new TextEncoder().encode(`partition-payload-${i}`)],
    }));
    const f = historyAssetsFixture(inputs);
    f.root.partitionCount = 16;
    f.publish();
    const bindings = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [
        `HISTORY_ASSETS_${i.toString(16)}`,
        { fetch: f.fetch },
      ]),
    );
    const source = historyAssetSource({ ...f.env, ...bindings }, fallback());
    let completed = 0,
      error: unknown;
    for (let i = 0; i < 6000; i++) {
      try {
        await source.read(inputs[i % inputs.length].key, etag, 0, 1);
        completed++;
      } catch (caught) {
        error = caught;
        break;
      }
    }
    expect(completed).toBeGreaterThan(1024);
    expect(String(error)).toMatch(/transfer budget/);
    expect(f.fetch).toHaveBeenCalledTimes(4096);
  });
  it("keeps the exact source when unconfigured", () => {
    const r2 = fallback();
    for (const env of [undefined, null, {}])
      expect(historyAssetSource(env, r2)).toBe(r2);
  });
  it.each([
    { HISTORY_ASSET_RELEASE: `${"a".repeat(64)}:1` },
    { HISTORY_ASSETS: { fetch() {} } },
    { HISTORY_ASSETS: null, HISTORY_ASSET_RELEASE: `${"a".repeat(64)}:1` },
    { HISTORY_ASSETS: {}, HISTORY_ASSET_RELEASE: `${"a".repeat(64)}:1` },
    {
      HISTORY_ASSETS: { fetch: "invalid" },
      HISTORY_ASSET_RELEASE: `${"a".repeat(64)}:1`,
    },
    { HISTORY_ASSETS: { fetch() {} }, HISTORY_ASSET_RELEASE: "bad" },
    { HISTORY_ASSETS: { fetch() {} }, HISTORY_ASSET_RELEASE: 17 },
    {
      HISTORY_ASSETS: { fetch() {} },
      HISTORY_ASSET_RELEASE: `${"a".repeat(64)}:524289`,
    },
  ])("refuses partial or malformed activation: %j", (env) => {
    expect(() => historyAssetSource(env, fallback())).toThrow(/configuration/);
  });
  it("leaves mutable manifests, account history and canonical Parquet on their existing source", async () => {
    const f = setup();
    for (const k of [
      "current.json",
      key.replace("extrinsics", "account_events"),
      key.replace(/directory\/.+$/, "manifest.json"),
      key.replace(/\.json$/, ".parquet"),
    ])
      expect(new Uint8Array(await f.source.read(k, etag, 0, 1))).toEqual(
        new Uint8Array([99]),
      );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.r2.read).toHaveBeenCalledTimes(4);
  });
  it("returns exact cross-chunk ranges and caller-owned buffers without repeat payload reads", async () => {
    const f = setup();
    const first = new Uint8Array(await f.source.read(key, etag, 2, 3));
    expect(first).toEqual(new Uint8Array([3, 4, 5]));
    first.fill(0);
    expect(new Uint8Array(await f.source.read(key, etag, 0, 6))).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6]),
    );
    expect(new Uint8Array(await f.source.read(key, etag, 4, 1))).toEqual(
      new Uint8Array([5]),
    );
    expect(f.fetch).toHaveBeenCalledTimes(4);
    expect(f.r2.read).not.toHaveBeenCalled();
    await historyAssetSource(f.env, f.r2).read(key, etag, 0, 1);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });
  it("accepts exact decimal Content-Length", async () => {
    const f = setup();
    f.override(
      (_hash, raw) =>
        raw &&
        new Response(raw, {
          headers: { "content-length": String(raw.length) },
        }),
    );
    expect(new Uint8Array(await f.source.read(key, etag, 0, 1))).toEqual(
      new Uint8Array([1]),
    );
  });
  it("falls back only when the verified release does not map an object", async () => {
    const f = setup();
    f.publishRoot({ version: 1, shards: {} });
    expect(
      new Uint8Array(
        await historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ),
    ).toEqual(new Uint8Array([99]));
    f.shards[assetHash(key).slice(0, 2)].objects = {};
    f.publish();
    expect(
      new Uint8Array(
        await historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ),
    ).toEqual(new Uint8Array([99]));
    expect(f.r2.read).toHaveBeenCalledTimes(2);
  });
  it.each([
    [-1, 1],
    [0, 0],
    [0, -1],
    [0.5, 1],
    [0, 1.5],
    [NaN, 1],
    [Infinity, 1],
    [0, 16 * 1024 * 1024 + 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ])("refuses invalid range %s/%s before I/O", async (offset, length) => {
    const f = setup();
    await expect(f.source.read(key, etag, offset, length)).rejects.toThrow(
      /range/,
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.r2.read).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong-etag", 0, 1],
    [etag, 6, 1],
  ] as const)(
    "refuses original identity/bounds mismatch",
    async (expected, offset, length) => {
      const f = setup();
      await expect(
        f.source.read(key, expected, offset, length),
      ).rejects.toThrow(/original identity/);
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.r2.read).not.toHaveBeenCalled();
    },
  );
  it.each(["key", "bytes"])("refuses a changed %s mapping", async (field) => {
    const f = setup(),
      object = f.shards[assetHash(key).slice(0, 2)].objects[assetHash(key)];
    if (field === "key") object.key = assetKey("different");
    else object.bytes++;
    f.publish();
    await expect(
      historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
    ).rejects.toThrow(/mapping/);
    expect(f.r2.read).not.toHaveBeenCalled();
  });
  it.each(["abc", "3.0", "1e2", "-1", "0", "10000000"])(
    "rejects invalid declared asset length %s and cancels",
    async (length) => {
      const f = setup();
      let canceled = false;
      f.override(
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array([1]));
              },
              cancel() {
                canceled = true;
              },
            }),
            { headers: { "content-length": length } },
          ),
      );
      await expect(f.source.read(key, etag, 0, 1)).rejects.toThrow(
        /missing or changed/,
      );
      expect(canceled).toBe(true);
    },
  );
  it.each([404, 500, 206])(
    "rejects HTTP %s without an R2 fallback",
    async (status) => {
      const f = setup();
      f.override(() => new Response(null, { status }));
      await expect(f.source.read(key, etag, 0, 1)).rejects.toThrow(
        /missing or changed/,
      );
      expect(f.r2.read).not.toHaveBeenCalled();
    },
  );
  it("rejects a successful response without a body", async () => {
    const f = setup();
    f.override(() => new Response(null));
    await expect(f.source.read(key, etag, 0, 1)).rejects.toThrow(
      /missing or changed/,
    );
  });
  it("cancels a streamed body as soon as it exceeds its pinned size", async () => {
    const f = setup();
    let canceled = false;
    f.override((hash) =>
      hash === assetHash(input().chunks[0])
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new Uint8Array(4));
              },
              cancel() {
                canceled = true;
              },
            }),
          )
        : undefined,
    );
    await expect(f.source.read(key, etag, 0, 1)).rejects.toThrow(/size bound/);
    expect(canceled).toBe(true);
  });
  it.each([new Uint8Array([1, 2]), new Uint8Array([1, 2, 9])])(
    "rejects truncated/corrupt bytes",
    async (raw) => {
      const f = setup();
      f.override((hash) =>
        hash === assetHash(input().chunks[0]) ? new Response(raw) : undefined,
      );
      await expect(f.source.read(key, etag, 0, 1)).rejects.toThrow(
        /content identity/,
      );
    },
  );
  it("rejects malformed JSON and UTF-8 even when their hash is pinned", async () => {
    for (const raw of [new TextEncoder().encode("{"), new Uint8Array([255])]) {
      const f = setup(),
        hash = assetHash(raw);
      f.files.set(hash, raw);
      f.env.HISTORY_ASSET_RELEASE = `${hash}:${raw.length}`;
      await expect(
        historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
      ).rejects.toThrow();
    }
  });
  it("rejects invalid release and shard schemas", async () => {
    const f = setup();
    f.publishRoot({ version: 2, shards: {} });
    await expect(
      historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
    ).rejects.toThrow();
    f.shards[assetHash(key).slice(0, 2)].objects[assetHash(key)].chunks = [];
    f.publish();
    await expect(
      historyAssetSource(f.env, f.r2).read(key, etag, 0, 1),
    ).rejects.toThrow();
  });
  it("detects conflicting pinned sizes even for a cached content hash", async () => {
    const second = assetKey("second"),
      f = historyAssetsFixture([
        input(),
        { key: second, etag, chunks: [input().chunks[0]] },
      ]);
    const o =
      f.shards[assetHash(second).slice(0, 2)].objects[assetHash(second)];
    o.bytes = 4;
    o.chunks[0].bytes = 4;
    f.publish();
    const source = historyAssetSource(f.env, fallback());
    await source.read(key, etag, 0, 1);
    await expect(source.read(second, etag, 0, 1)).rejects.toThrow(
      /size conflict/,
    );
  });
  it("bounds transferred bytes despite small requested ranges and bounded cache eviction", async () => {
    const chunks = [1, 2, 3].map((n) => {
      const b = new Uint8Array(4 * 1024 * 1024);
      b[0] = n;
      return b;
    });
    const f = historyAssetsFixture([{ key, etag, chunks }]),
      source = historyAssetSource(f.env, fallback());
    let error: unknown;
    for (let i = 0; i < 40; i++) {
      try {
        await source.read(key, etag, (i % 3) * 4 * 1024 * 1024, 1);
      } catch (caught) {
        error = caught;
        break;
      }
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/transfer budget/);
    expect(f.fetch.mock.calls.length).toBeLessThan(40);
  });
  it("bounds tiny-asset requests and parsed shard retention", async () => {
    const inputs = Array.from({ length: 300 }, (_, i) => ({
      key: assetKey(`object-${i}`),
      etag,
      chunks: [new TextEncoder().encode(`payload-${i}`)],
    }));
    const f = historyAssetsFixture(inputs),
      source = historyAssetSource(f.env, fallback());
    let error: unknown;
    for (let i = 0; i < 1500; i++) {
      try {
        await source.read(inputs[i % inputs.length].key, etag, 0, 1);
      } catch (caught) {
        error = caught;
        break;
      }
    }
    expect(String(error)).toMatch(/transfer budget/);
    expect(f.fetch).toHaveBeenCalledTimes(1024);
  });
});
