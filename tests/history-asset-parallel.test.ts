import { describe, expect, it, vi } from "vitest";
import { historyAssetSource } from "../src/history-asset-source.ts";
import {
  assetHash,
  assetKey,
  historyAssetsFixture,
} from "./history-assets-fixture.ts";

const key = assetKey("parallel").replace(".json", ".bin"),
  etag = "b".repeat(32);
function controlled(chunks: Uint8Array[]) {
  const f = historyAssetsFixture([{ key, etag, chunks }]);
  const hashes = new Set(chunks.map(assetHash));
  const original = f.fetch.getMockImplementation()!;
  const waiting = new Map<string, (response: Response) => void>();
  const started: string[] = [];
  let active = 0,
    peak = 0;
  f.fetch.mockImplementation(async (request) => {
    const hash = new URL(request.url).pathname.slice(1, -7);
    if (!hashes.has(hash)) return original(request);
    started.push(hash);
    active++;
    peak = Math.max(peak, active);
    const response = await new Promise<Response>((resolve) =>
      waiting.set(hash, resolve),
    );
    active--;
    return response;
  });
  const r2 = { read: vi.fn(async () => new ArrayBuffer(0)) };
  return {
    ...f,
    started,
    waiting,
    r2,
    source: historyAssetSource(f.env, r2),
    get peak() {
      return peak;
    },
    get active() {
      return active;
    },
    release(hash: string, response = new Response(f.files.get(hash)!)) {
      const resolve = waiting.get(hash)!;
      waiting.delete(hash);
      resolve(response);
    },
  };
}

describe("bounded parallel immutable history reads", () => {
  it("preserves partial range order and fetches repeated digests once with four reads in flight", async () => {
    const unique = Array.from(
      { length: 7 },
      (_, i) => new Uint8Array([i * 3, i * 3 + 1, i * 3 + 2]),
    );
    const chunks = [...unique, unique[0]],
      f = controlled(chunks);
    const expected = new Uint8Array(chunks.flatMap((c) => [...c])).slice(1, -1);
    const result = f.source.read(key, etag, 1, expected.length);
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
    // Complete later chunks first while the first three remain outstanding.
    for (let n = 4; n < 7; n++) {
      f.release(f.started[n - 1]);
      await vi.waitFor(() => expect(f.started).toHaveLength(n + 1));
    }
    for (const hash of [...f.waiting.keys()].reverse()) f.release(hash);
    expect(new Uint8Array(await result)).toEqual(expected);
    expect(f.peak).toBe(4);
    expect(f.active).toBe(0);
    expect(f.started).toHaveLength(7);
    expect(new Set(f.started).size).toBe(7);
    expect(f.fetch).toHaveBeenCalledTimes(9);
    expect(f.r2.read).not.toHaveBeenCalled();
  });

  it("stops queued chunks on failure and drains outstanding work before rejecting without R2 fallback", async () => {
    const f = controlled(
      Array.from({ length: 7 }, (_, i) => new Uint8Array([i])),
    );
    let settled = false;
    const result = f.source.read(key, etag, 0, 7).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(f.started).toHaveLength(4));
    const cancel = vi.fn();
    f.release(
      f.started[0],
      new Response(new ReadableStream({ cancel }), { status: 404 }),
    );
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    for (const hash of [...f.waiting.keys()]) f.release(hash);
    expect(await result).toMatchObject({
      message: "Immutable history asset missing or changed",
    });
    expect(f.started).toHaveLength(4);
    expect(f.active).toBe(0);
    expect(f.r2.read).not.toHaveBeenCalled();
  });

  it("rejects conflicting sizes for a repeated digest before payload reads", async () => {
    const f = historyAssetsFixture([
      { key, etag, chunks: [new Uint8Array([1, 2]), new Uint8Array([3, 4])] },
    ]);
    const object = f.shards[assetHash(key).slice(0, 2)].objects[assetHash(key)];
    object.chunks[1] = { ...object.chunks[0], bytes: 3 };
    object.bytes = 5;
    f.publish();
    const r2 = { read: vi.fn() };
    await expect(
      historyAssetSource(f.env, r2).read(key, etag, 0, 5),
    ).rejects.toThrow(/size conflict/);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(r2.read).not.toHaveBeenCalled();
  });
});
