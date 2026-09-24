import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectRegistryHashes,
  cloudflareRegistryStore,
  type RegistryObject,
  type RegistryStore,
} from "../scripts/r2-registry-gc.ts";

const key = (n: number) => `by-hash/${n.toString(16).padStart(64, "0")}`;
const now = Date.parse("2026-09-24T00:00:00Z");
function fixture() {
  const object = (
    n: number,
    date = "2026-08-01T00:00:00Z",
  ): RegistryObject => ({
    key: key(n),
    etag: String(n),
    size: n * 10,
    last_modified: date,
  });
  const objects = [
    object(1),
    object(2),
    object(3),
    object(4, "2026-09-23T00:00:00Z"),
  ];
  const manifests: Record<string, unknown> = {
    "runs/current/r2-manifest.json": { artifacts: [{ key: key(1) }] },
    "runs/retained/r2-manifest.json": { artifacts: [{ key: key(2) }] },
    "latest/r2-manifest.json": { artifacts: [{ key: key(1) }] },
  };
  const store: RegistryStore = {
    list: vi.fn(async (prefix) =>
      prefix === "by-hash/"
        ? objects.map((o) => ({ ...o }))
        : Object.keys(manifests)
            .filter((k) => k.startsWith("runs/"))
            .map((k) => ({
              key: k,
              etag: "manifest",
              size: 100,
              last_modified: "2026-09-01T00:00:00Z",
            })),
    ),
    read: vi.fn(async (k) => manifests[k]),
    pointer: vi.fn(async () => ({
      full_manifest_run_key: "runs/current/r2-manifest.json",
    })),
    remove: vi.fn(async (keys) => {
      for (let i = objects.length - 1; i >= 0; i--)
        if (keys.includes(objects[i].key)) objects.splice(i, 1);
    }),
  };
  return { store, objects, manifests };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("registry reachability collection", () => {
  it("plans without deleting, retaining current, historic and recent hashes", async () => {
    const { store } = fixture();
    expect(await collectRegistryHashes(store, { now })).toMatchObject({
      candidates: 1,
      candidateBytes: 30,
      deleted: 0,
    });
    expect(store.remove).not.toHaveBeenCalled();
  });
  it("deletes only the old orphan and verifies all retained references", async () => {
    const { store, objects } = fixture();
    expect(
      await collectRegistryHashes(store, { now, write: true }),
    ).toMatchObject({ deleted: 1, deletedBytes: 30 });
    expect(store.remove).toHaveBeenCalledWith([key(3)]);
    expect(objects.map((o) => o.key)).toEqual([key(1), key(2), key(4)]);
  });
  it("protects the latest manifest independently of the live pointer", async () => {
    const { store, manifests } = fixture();
    manifests["latest/r2-manifest.json"] = { artifacts: [{ key: key(3) }] };
    expect(
      await collectRegistryHashes(store, { now, write: true }),
    ).toMatchObject({ candidates: 0, deleted: 0 });
  });
  it.each([{}, { artifacts: [] }, { artifacts: [{ key: "elsewhere/data" }] }])(
    "rejects malformed manifests before mutation: %j",
    async (bad) => {
      const { store, manifests } = fixture();
      manifests["runs/retained/r2-manifest.json"] = bad;
      await expect(
        collectRegistryHashes(store, { now, write: true }),
      ).rejects.toThrow();
      expect(store.remove).not.toHaveBeenCalled();
    },
  );
  it("refuses missing retained artifacts", async () => {
    const { store, objects } = fixture();
    objects.splice(1, 1);
    await expect(
      collectRegistryHashes(store, { now, write: true }),
    ).rejects.toThrow(/missing/);
    expect(store.remove).not.toHaveBeenCalled();
  });
  it("refuses a pointer change during planning", async () => {
    const { store } = fixture();
    vi.mocked(store.pointer).mockResolvedValueOnce({
      full_manifest_run_key: "runs/retained/r2-manifest.json",
    });
    await expect(
      collectRegistryHashes(store, { now, write: true }),
    ).rejects.toThrow(/publication changed/);
    expect(store.remove).not.toHaveBeenCalled();
  });
  it("refuses a candidate overwrite before deletion", async () => {
    const { store } = fixture();
    const original = store.list;
    let reads = 0;
    store.list = async (prefix) => {
      const list = await original(prefix);
      if (prefix === "by-hash/" && ++reads === 2) list[2].etag = "changed";
      return list;
    };
    await expect(
      collectRegistryHashes(store, { now, write: true }),
    ).rejects.toThrow(/identity changed/);
    expect(store.remove).not.toHaveBeenCalled();
  });
  it("refuses duplicate enumeration and malformed pointers", async () => {
    const { store, objects } = fixture();
    objects.push(objects[0]);
    await expect(collectRegistryHashes(store, { now })).rejects.toThrow(
      /incomplete/,
    );
    vi.mocked(store.pointer).mockResolvedValue({});
    await expect(collectRegistryHashes(store, { now })).rejects.toThrow(
      /pointer/,
    );
  });
  it("detects a deletion that failed to remove its key", async () => {
    const { store } = fixture();
    vi.mocked(store.remove).mockResolvedValue();
    await expect(
      collectRegistryHashes(store, { now, write: true }),
    ).rejects.toThrow(/readback failed/);
  });
  it("keeps objects on the grace boundary or with invalid ages", async () => {
    const { store, objects } = fixture();
    objects[2].last_modified = "2026-09-10T00:00:00Z";
    expect(await collectRegistryHashes(store, { now })).toMatchObject({
      candidates: 0,
    });
    objects[2].last_modified = "unknown";
    expect(await collectRegistryHashes(store, { now })).toMatchObject({
      candidates: 0,
    });
  });
});
describe("registry API boundary", () => {
  const store = () =>
    cloudflareRegistryStore("account", "fixture-token", "namespace");
  const reply = (value: unknown) => new Response(JSON.stringify(value));
  it("paginates metadata and rejects repeated cursors", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () =>
      reply({
        success: true,
        result: [],
        result_info: { is_truncated: true, cursor: "same" },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const promise = expect(store().list("runs/")).rejects.toThrow(/cursor/);
    await vi.runAllTimersAsync();
    await promise;
  });
  it("fails closed on missing pagination state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          reply({ success: true, result: [], result_info: {} }),
        ),
    );
    await expect(store().list("runs/")).rejects.toThrow(/pagination/);
  });
  it("sends exact delete keys without a prefix and checks every result", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(reply({ success: true, result: [{ key: key(3) }] }));
    vi.stubGlobal("fetch", fetcher);
    await store().remove([key(3)]);
    expect(fetcher.mock.calls[0][0]).not.toContain("?");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual([key(3)]);
    fetcher.mockResolvedValue(reply({ success: true, result: [] }));
    await expect(store().remove([key(3)])).rejects.toThrow(/every key/);
    await expect(store().remove(["latest/r2-manifest.json"])).rejects.toThrow(
      /scope/,
    );
  });
});
