import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectHistoryGenerations,
  cloudflareHistoryGcStore,
  HISTORY_GC_CHECKPOINT,
  type HistoryGcStore,
} from "../scripts/r2-history-gc.ts";
import { RUNTIME_CURATED_EVENT_KINDS } from "../schemas-src/artifacts/runtime-account-curation.ts";
import type { RegistryObject } from "../scripts/r2-registry-gc.ts";

const now = Date.parse("2026-09-25T00:00:00Z");
const generation = (n: number) => n.toString(16).padStart(64, "0");
const prefix = (n = 4, network = "mainnet", table = "blocks") =>
  `metagraph/indexed-history/v1/${network}/${table}/generations/${generation(n)}/`;
const descriptor = (key: string) => ({ key, etag: "etag", bytes: 100 });
function fixture() {
  const metadata = new Map<string, unknown>();
  const objects: RegistryObject[] = [];
  const directories: string[] = [];
  function segment(
    network: string,
    table: string,
    n: number,
    firstBlock: number,
    lastBlock: number,
  ) {
    return {
      network,
      table,
      generation: generation(n),
      firstBlock,
      lastBlock,
      blockManifest: descriptor(
        prefix(n, network, table) + "block-manifest.json",
      ),
      ...(["blocks", "extrinsics"].includes(table)
        ? {
            hashManifest: descriptor(
              prefix(n, network, table) + "manifest.json",
            ),
          }
        : {}),
    };
  }
  for (const network of ["mainnet", "testnet"]) {
    for (const table of [
      "blocks",
      "extrinsics",
      "chain_events",
      "account_events",
    ]) {
      const selected = [
        segment(network, table, 1, 0, 100),
        segment(network, table, 2, 101, 300),
      ];
      metadata.set(
        `metagraph/indexed-history/v1/${network}/${table}/current.json`,
        { version: 2, network, table, segments: selected },
      );
      directories.push(prefix(1, network, table), prefix(2, network, table));
    }
    const root = `metagraph/runtime-account-curation/v1/${network}/`;
    metadata.set(root + "current.json", {
      version: 1,
      network,
      manifest: descriptor(root + generation(3) + "/manifest.json"),
    });
    metadata.set(root + generation(3) + "/manifest.json", {
      version: 1,
      state: "complete",
      network,
      selection: {
        ...segment(network, "account_events", 3, 101, 200),
      },
      sourceSnapshot: "123",
      sourceUuid: "uuid",
      binarySha256: generation(1),
      rows: 0,
      counts: Object.fromEntries(
        RUNTIME_CURATED_EVENT_KINDS.map((kind) => [kind, 0]),
      ),
      sourceProof: descriptor(root + generation(3) + "/source-proof.json"),
      accountManifest: descriptor(
        prefix(3, network, "account_events") + "accounts/v1/manifest.json",
      ),
    });
  }
  function add(n = 4, network = "mainnet", table = "blocks", count = 4) {
    const base = prefix(n, network, table);
    directories.push(base);
    for (const name of [
      "block-manifest.json",
      `publication-proof-${"a".repeat(40)}.json`,
      ...Array.from({ length: count }, (_, i) => `index/${i}.bin`),
    ]) {
      objects.push({
        key: base + name,
        etag: "etag",
        size: 100,
        last_modified: "2026-09-01T00:00:00Z",
      });
    }
    metadata.set(base + `publication-proof-${"a".repeat(40)}.json`, {
      version: 1,
      generation: generation(n),
      firstBlock: 101,
      lastBlock: 200,
      blockManifest: descriptor(base + "block-manifest.json"),
    });
    return base;
  }
  add();
  const checkpoint = () => ({
    version: 1,
    observations: Object.fromEntries(
      directories.map((p) => [p, { since: now - 3600001, checked: 0 }]),
    ),
  });
  metadata.set(HISTORY_GC_CHECKPOINT, checkpoint());
  const store: HistoryGcStore = {
    list: vi.fn(async (p, delimiter) =>
      delimiter
        ? { objects: [], prefixes: directories.filter((d) => d.startsWith(p)) }
        : {
            objects: objects
              .filter((o) => o.key.startsWith(p))
              .map((o) => ({ ...o })),
            prefixes: [],
          },
    ),
    read: vi.fn(async (key) => structuredClone(metadata.get(key) ?? null)),
    write: vi.fn(async (key, value) => {
      metadata.set(key, structuredClone(value));
    }),
    remove: vi.fn(async (keys) => {
      for (let i = objects.length - 1; i >= 0; i--)
        if (keys.includes(objects[i].key)) objects.splice(i, 1);
      for (let i = directories.length - 1; i >= 0; i--)
        if (
          !objects.some((o) => o.key.startsWith(directories[i])) &&
          directories[i] === prefix()
        )
          directories.splice(i, 1);
    }),
  };
  return { store, metadata, objects, directories, add, checkpoint };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe("native history collection", () => {
  it("plans without altering the observation checkpoint or any data", async () => {
    const f = fixture();
    expect(await collectHistoryGenerations(f.store, { now })).toMatchObject({
      candidates: 6,
      deleted: 0,
    });
    expect(f.store.remove).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
  });
  it("collects a proven superseded tail while preserving every selected generation", async () => {
    const f = fixture();
    expect(
      await collectHistoryGenerations(f.store, { now, write: true }),
    ).toMatchObject({ deleted: 6, deletedBytes: 600 });
    expect(f.objects).toEqual([]);
    expect(f.store.remove).toHaveBeenCalledWith(
      expect.arrayContaining([prefix() + "block-manifest.json"]),
    );
  });
  it("requires a second observation, and dry runs cannot create the first", async () => {
    const f = fixture();
    f.metadata.delete(HISTORY_GC_CHECKPOINT);
    expect(
      await collectHistoryGenerations(f.store, { now, write: true }),
    ).toMatchObject({ inspected: 0, deleted: 0 });
    expect(
      await collectHistoryGenerations(f.store, {
        now: now + 3599999,
        write: true,
      }),
    ).toMatchObject({ deleted: 0 });
    expect(
      await collectHistoryGenerations(f.store, {
        now: now + 3600000,
        write: true,
      }),
    ).toMatchObject({ deleted: 6 });
  });
  it("protects independently selected runtime corrections", async () => {
    const f = fixture();
    f.add(3, "mainnet", "account_events");
    f.metadata.set(HISTORY_GC_CHECKPOINT, f.checkpoint());
    await collectHistoryGenerations(f.store, { now, write: true });
    expect(f.objects).toHaveLength(6);
    expect(
      f.objects.every((o) =>
        o.key.startsWith(prefix(3, "mainnet", "account_events")),
      ),
    ).toBe(true);
  });
  it("protects young objects and incomplete generations", async () => {
    const f = fixture();
    f.objects[0].last_modified = new Date(now - 60000).toISOString();
    expect(
      await collectHistoryGenerations(f.store, { now, write: true }),
    ).toMatchObject({ deleted: 0 });
    f.objects[0].last_modified = "2026-09-01T00:00:00Z";
    f.objects.splice(1, 1);
    expect(
      await collectHistoryGenerations(f.store, { now, write: true }),
    ).toMatchObject({ deleted: 0 });
  });
  it.each(["firstBlock", "lastBlock", "generation", "blockManifest"])(
    "refuses a mismatched publication proof %s",
    async (field) => {
      const f = fixture(),
        key = prefix() + `publication-proof-${"a".repeat(40)}.json`;
      const bad = {
        version: 1,
        generation: generation(4),
        firstBlock: 101,
        lastBlock: 200,
        blockManifest: descriptor(prefix() + "block-manifest.json"),
        [field]:
          field === "firstBlock"
            ? 50
            : field === "lastBlock"
              ? 301
              : field === "generation"
                ? generation(2)
                : descriptor("foreign"),
      };
      f.metadata.set(key, bad);
      expect(
        await collectHistoryGenerations(f.store, { now, write: true }),
      ).toMatchObject({ deleted: 0 });
    },
  );
  it("refuses absent correction metadata before deleting", async () => {
    const f = fixture();
    f.metadata.delete(
      "metagraph/runtime-account-curation/v1/testnet/current.json",
    );
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it("refuses a noncontiguous selector", async () => {
    const f = fixture();
    f.metadata.set("metagraph/indexed-history/v1/mainnet/blocks/current.json", {
      version: 2,
      network: "mainnet",
      table: "blocks",
      segments: [],
    });
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it("refuses a candidate overwritten between listings", async () => {
    const f = fixture(),
      list = f.store.list;
    let count = 0;
    f.store.list = vi.fn(async (p, d) => {
      if (p === prefix() && !d && ++count === 2) f.objects[0].etag = "changed";
      return list(p, d);
    });
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow(/identity changed/);
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it("refuses a moving selector before each delete batch", async () => {
    const f = fixture(),
      read = f.store.read;
    let reads = 0;
    f.store.read = vi.fn(async (key) => {
      const value = await read(key);
      if (key.endsWith("mainnet/blocks/current.json") && ++reads === 2)
        return null;
      return value;
    });
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it("keeps qualification metadata through interruption and resumes remaining exact keys", async () => {
    const f = fixture();
    f.objects.length = 0;
    f.directories.pop();
    f.add(4, "mainnet", "blocks", 150);
    const remove = f.store.remove;
    let calls = 0;
    f.store.remove = vi.fn(async (keys) => {
      if (++calls === 2) throw new Error("interrupted");
      await remove(keys);
    });
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow("interrupted");
    expect(f.objects.some((o) => o.key.endsWith("block-manifest.json"))).toBe(
      true,
    );
    expect(f.objects.some((o) => o.key.includes("publication-proof-"))).toBe(
      true,
    );
    f.store.remove = remove;
    expect(
      await collectHistoryGenerations(f.store, { now, write: true }),
    ).toMatchObject({ deleted: 52 });
  });
  it("rejects incomplete deletion readback", async () => {
    const f = fixture();
    f.store.remove = vi.fn(async () => {});
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow(/readback/);
  });
  it.each([
    { version: 2, observations: {} },
    { version: 1, observations: { unrelated: { since: 0, checked: 0 } } },
    {
      version: 1,
      observations: { [prefix()]: { since: now + 1, checked: 0 } },
    },
  ])("rejects malformed persistent observations", async (checkpoint) => {
    const f = fixture();
    f.metadata.set(HISTORY_GC_CHECKPOINT, checkpoint);
    await expect(
      collectHistoryGenerations(f.store, { now, write: true }),
    ).rejects.toThrow();
    expect(f.store.remove).not.toHaveBeenCalled();
  });
  it("does not delete outside the exact immutable generation", async () => {
    const f = fixture();
    f.objects.push({
      ...f.objects[0],
      key: "metagraph/indexed-history/v1/mainnet/blocks/repacked/source.parquet",
    });
    await collectHistoryGenerations(f.store, { now, write: true });
    expect(f.objects).toHaveLength(1);
    expect(f.objects[0].key).toContain("repacked/");
  });
});
describe("history R2 adapter", () => {
  const listedObjects = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      key: prefix() + `files/${i}.json`,
      etag: `etag-${i}`,
      size: 100,
      last_modified: "2026-09-01T00:00:00Z",
    }));
  it.each([0, 54, 999])(
    "accepts a terminal %i-object page without result_info",
    async (count) => {
      const objects = listedObjects(count);
      const fetcher = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, result: objects })),
        );
      vi.stubGlobal("fetch", fetcher);
      expect(
        await cloudflareHistoryGcStore("account", "token").list(prefix()),
      ).toEqual({ objects, prefixes: [] });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([1000, 1001])(
    "refuses an ambiguous %i-object page without result_info",
    async (count) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(
              JSON.stringify({ success: true, result: listedObjects(count) }),
            ),
          ),
      );
      await expect(
        cloudflareHistoryGcStore("account", "token").list(prefix()),
      ).rejects.toThrow(/metadata/);
    },
  );
  it("does not infer completion for a delimiter listing without metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, result: [] })),
        ),
    );
    await expect(
      cloudflareHistoryGcStore("account", "token").list(prefix(), "/"),
    ).rejects.toThrow(/metadata/);
  });
  it("ends an explicit continuation at a short page without result_info", async () => {
    vi.useFakeTimers();
    const objects = listedObjects(2);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [objects[0]],
            result_info: { is_truncated: true, cursor: "next" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, result: [objects[1]] })),
      );
    vi.stubGlobal("fetch", fetcher);
    const listing = cloudflareHistoryGcStore("account", "token").list(prefix());
    await vi.runAllTimersAsync();
    expect(await listing).toEqual({ objects, prefixes: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toContain("cursor=next");
  });
  it("accepts the terminal delimiter-only response returned by R2", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [],
            result_info: { delimited: [prefix()] },
          }),
        ),
      ),
    );
    expect(
      (
        await cloudflareHistoryGcStore("account", "token").list(
          "metagraph/indexed-history/v1/mainnet/blocks/generations/",
          "/",
        )
      ).prefixes,
    ).toEqual([prefix()]);
  });
  it("paginates delimiter listings and preserves literal object-key slashes", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [],
            result_info: {
              is_truncated: true,
              cursor: "next",
              delimited: [prefix()],
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            result: [],
            result_info: { is_truncated: false, delimited: [prefix(5)] },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response("null", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const store = cloudflareHistoryGcStore("account", "token");
    const listing = store.list(
      "metagraph/indexed-history/v1/mainnet/blocks/generations/",
      "/",
    );
    await vi.runAllTimersAsync();
    expect((await listing).prefixes).toEqual([prefix(), prefix(5)]);
    expect(String(fetch.mock.calls[1][0])).toContain("cursor=next");
    const missing = store.read(prefix() + "block-manifest.json");
    await vi.runAllTimersAsync();
    expect(await missing).toBeNull();
    expect(String(fetch.mock.calls[2][0])).toContain(
      prefix() + "block-manifest.json",
    );
  });
  it("refuses cross-scope deletes and non-checkpoint writes before fetching", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const store = cloudflareHistoryGcStore("account", "token");
    await expect(
      store.remove(["metagraph/bulk/important.parquet"]),
    ).rejects.toThrow(/scope/);
    await expect(store.write("wrong", {})).rejects.toThrow(/checkpoint key/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires exact per-key delete receipts", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ success: true, result: [] })),
        ),
    );
    await expect(
      cloudflareHistoryGcStore("account", "token").remove([
        prefix() + "index/0.bin",
      ]),
    ).rejects.toThrow(/receipt/);
  });
  it("does not reinterpret transport errors as missing roots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    await expect(
      cloudflareHistoryGcStore("account", "token").read(HISTORY_GC_CHECKPOINT),
    ).rejects.toThrow(/HTTP 503/);
  });
  it("rejects truncated inventory without a continuation cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            result: [],
            result_info: { is_truncated: true },
          }),
        ),
      ),
    );
    await expect(
      cloudflareHistoryGcStore("account", "token").list(prefix()),
    ).rejects.toThrow(/pagination/);
  });
});
