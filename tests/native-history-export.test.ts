import { afterEach, describe, expect, it, vi } from "vitest";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { handleNativeHistoryExport } from "../src/native-history-export.ts";
import * as assets from "../src/history-asset-source.ts";
import { handleRequest } from "../workers/api.ts";
import {
  assetHash,
  assetKey,
  historyAssetsFixture,
} from "./history-assets-fixture.ts";

const key = `metagraph/indexed-history/v1/mainnet/blocks/${"a".repeat(64)}/00000-${"c".repeat(64)}.parquet`;
const etag = "b".repeat(32);
const raw = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
const head = { kind: "native-history", operation: "head", key };
const range = { ...head, operation: "range", etag, offset: 2, length: 3 };
function fixture(checksum = true) {
  const f = historyAssetsFixture([
    { key, etag, chunks: [raw.slice(0, 3), raw.slice(3)] },
  ]);
  const object = Object.values(f.shards)[0].objects[assetHash(key)];
  if (checksum) Object.assign(object, { sha256: assetHash(raw) });
  f.publish();
  const env = {
    STATE_EXPORT_SECRET: "existing-producer-secret",
    NATIVE_HISTORY_ASSETS: f.env.HISTORY_ASSETS,
    NATIVE_HISTORY_ASSET_RELEASE: f.env.HISTORY_ASSET_RELEASE,
    METAGRAPH_ARCHIVE: {
      get: vi.fn(() => {
        throw new Error("R2 must not be consulted");
      }),
    },
  };
  return { ...f, env, object };
}
const request = (input: unknown, secret = "existing-producer-secret") =>
  new Request("https://example.com/api/v1/internal/state-export", {
    method: "POST",
    headers: { "x-state-export-token": secret },
    body: JSON.stringify(input),
  });
afterEach(() => vi.restoreAllMocks());

describe("credential-protected native history producer reads", () => {
  it("preserves native binary ranges through the public API proxy", async () => {
    const f = fixture();
    const env = {
      DATA_API: {
        fetch: (incoming: Request) => handleD1StateExport(incoming, f.env),
      },
    } as unknown as Env;
    const response = await handleRequest(request(range), env, {});
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      raw.slice(2, 5),
    );
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-range")).toBe("bytes 2-4/7");
    expect(response.headers.get("etag")).toBe(`"${etag}"`);
    expect(response.headers.get("x-history-sha256")).toBe(assetHash(raw));
    expect(response.headers.get("cache-control")).toBe("no-store");
    const denied = await handleRequest(request(range, "wrong"), env, {});
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toEqual({
      error: "invalid state export credential",
    });
    const metadata = await handleRequest(request(head), env, {});
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("cache-control")).toBe("no-store");
    expect(await metadata.json()).toEqual({
      version: 1,
      object: { key, etag, bytes: raw.length, sha256: assetHash(raw) },
    });
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it("forwards an export stream without buffering it in the public Worker", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(raw);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = new Response(stream, {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
    const response = await handleRequest(
      request(range),
      {
        DATA_API: { fetch: () => upstream },
      } as unknown as Env,
      {},
    );
    expect(pulls).toBe(0);
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
    expect(pulls).toBe(1);
  });

  it("uses the existing credential gate before disclosing metadata or reading assets", async () => {
    const f = fixture();
    const denied = await handleD1StateExport(request(head, "wrong"), f.env);
    expect(denied.status).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleD1StateExport(request(head), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      object: { key, etag, bytes: raw.length, sha256: assetHash(raw) },
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it("preserves original identity and exact cross-chunk binary ranges without R2", async () => {
    const f = fixture();
    const response = await handleD1StateExport(request(range), f.env);
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      raw.slice(2, 5),
    );
    expect(response.headers.get("etag")).toBe(`"${etag}"`);
    expect(response.headers.get("content-range")).toBe("bytes 2-4/7");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("x-history-sha256")).toBe(assetHash(raw));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it("rejects unsupported keys and malformed ranges before any asset access", async () => {
    const f = fixture();
    for (const input of [
      null,
      {},
      { ...head, key: "unrelated" },
      { ...head, key: key.replace(/[^/]+$/, "current.json") },
      { ...head, extra: true },
      { ...range, etag: "invalid" },
      { ...range, offset: -1 },
      { ...range, offset: 1.5 },
      { ...range, offset: 128 * 1024 * 1024 },
      { ...range, length: 0 },
      { ...range, length: 8 * 1024 * 1024 + 1 },
    ]) {
      const response = await handleNativeHistoryExport(input, f.env);
      expect(response.status).toBe(400);
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("distinguishes unmigrated objects from identity and range failures", async () => {
    const f = fixture();
    expect(
      (
        await handleNativeHistoryExport(
          { ...head, key: key.replace("00000-", "00001-") },
          f.env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleNativeHistoryExport(
          { ...range, etag: "d".repeat(32) },
          f.env,
        )
      ).status,
    ).toBe(412);
    expect(
      (
        await handleNativeHistoryExport(
          { ...range, offset: 6, length: 2 },
          f.env,
        )
      ).status,
    ).toBe(416);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it("requires a configured static source and a qualified original SHA256", async () => {
    expect((await handleNativeHistoryExport(head, {})).status).toBe(503);
    const f = fixture(false);
    expect((await handleNativeHistoryExport(head, f.env)).status).toBe(503);
    expect(
      (
        await handleNativeHistoryExport(head, {
          ...f.env,
          NATIVE_HISTORY_ASSET_RELEASE: "invalid",
        })
      ).status,
    ).toBe(502);
  });

  it("fails closed if the immutable source cannot be read", async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () => new Response("unavailable", { status: 503 }),
    );
    expect((await handleNativeHistoryExport(range, f.env)).status).toBe(502);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it("defensively rejects an attempted fallback even after successful metadata lookup", async () => {
    vi.spyOn(assets, "historyAssetSource").mockImplementationOnce(
      (_env, fallback) => ({
        describe: async () => ({
          key,
          etag,
          bytes: raw.length,
          sha256: assetHash(raw),
        }),
        read: fallback.read,
      }),
    );
    expect((await handleNativeHistoryExport(range, {})).status).toBe(502);
  });

  it("describes only mapped immutable keys and preserves feed compatibility", async () => {
    const f = fixture();
    const reader = assets.historyAssetSource(
      f.env,
      { read: vi.fn() },
      "NATIVE_HISTORY",
    );
    expect(await reader.describe!("unrelated")).toBeUndefined();
    expect(
      await reader.describe!(key.replace("00000-", "00002-")),
    ).toBeUndefined();
    const feed = historyAssetsFixture([
      { key: assetKey("feed"), etag, chunks: [raw] },
    ]);
    const source = assets.historyAssetSource(feed.env, { read: vi.fn() });
    expect(await source.describe!(assetKey("feed"))).toEqual({
      key: assetKey("feed"),
      etag,
      bytes: raw.length,
    });
  });
});

describe("bounded native history metadata batches", () => {
  const heads = (keys: string[]) => ({
    kind: "native-history",
    operation: "heads",
    keys,
  });
  const keys = Array.from({ length: 10 }, (_, i) =>
    key.replace("00000-", String(i).padStart(5, "0") + "-"),
  );
  const object = (key: string) => ({
    key,
    etag,
    bytes: raw.length,
    sha256: assetHash(raw),
  });

  it("returns metadata and explicit misses in request order through the authenticated proxy", async () => {
    const f = fixture();
    const env = {
      DATA_API: {
        fetch: (incoming: Request) => handleD1StateExport(incoming, f.env),
      },
    } as unknown as Env;
    expect(
      (await handleRequest(request(heads([key]), "wrong"), env, {})).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleRequest(
      request(heads([keys[1], key]), "existing-producer-secret"),
      env,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      objects: [null, object(key)],
    });
    // Only the release and its one populated metadata shard are fetched.
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    const single = await handleNativeHistoryExport(heads([key]), f.env);
    expect(await single.json()).toEqual({ version: 1, objects: [object(key)] });
  });

  it("rejects empty, duplicate, oversized and out-of-scope batches before access", async () => {
    const f = fixture();
    for (const input of [
      heads([]),
      heads([key, key]),
      heads(Array(65).fill(key)),
      heads(["unrelated"]),
      { ...heads([key]), extra: true },
    ])
      expect((await handleNativeHistoryExport(input, f.env)).status).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("limits metadata concurrency to four and retains order after out-of-order completion", async () => {
    const pending = new Map<
      string,
      (value: ReturnType<typeof object>) => void
    >();
    let active = 0,
      maximum = 0;
    const describe = vi.fn(
      (key: string) =>
        new Promise<ReturnType<typeof object>>((resolve) => {
          active++;
          maximum = Math.max(maximum, active);
          pending.set(key, (value) => {
            active--;
            pending.delete(key);
            resolve(value);
          });
        }),
    );
    vi.spyOn(assets, "historyAssetSource").mockReturnValue({
      describe,
      read: vi.fn(),
    });
    const response = handleNativeHistoryExport(heads(keys), {});
    await vi.waitFor(() => expect(pending.size).toBe(4));
    for (const index of [3, 2, 1, 0, 7, 6, 5, 4, 9, 8]) {
      await vi.waitFor(() => expect(pending.has(keys[index])).toBe(true));
      pending.get(keys[index])!(object(keys[index]));
    }
    const result = await response;
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      version: 1,
      objects: keys.map(object),
    });
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(describe).toHaveBeenCalledTimes(10);
  });

  it("stops queued requests and drains started requests before reporting a failure", async () => {
    const pending = new Map<
      string,
      {
        resolve: (value: ReturnType<typeof object>) => void;
        reject: (error: Error) => void;
      }
    >();
    const describe = vi.fn(
      (key: string) =>
        new Promise<ReturnType<typeof object>>((resolve, reject) =>
          pending.set(key, { resolve, reject }),
        ),
    );
    vi.spyOn(assets, "historyAssetSource").mockReturnValue({
      describe,
      read: vi.fn(),
    });
    let completed = false;
    const response = handleNativeHistoryExport(heads(keys), {}).then(
      (value) => {
        completed = true;
        return value;
      },
    );
    await vi.waitFor(() => expect(pending.size).toBe(4));
    pending.get(keys[0])!.reject(new Error("private upstream detail"));
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    for (const index of [3, 1, 2])
      pending.get(keys[index])!.resolve(object(keys[index]));
    const result = await response;
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      error: "native history static source is unavailable",
    });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(describe).toHaveBeenCalledTimes(4);
  });

  it("fails closed without a configured reader or a qualified checksum", async () => {
    expect((await handleNativeHistoryExport(heads([key]), {})).status).toBe(
      503,
    );
    const f = fixture(false);
    expect((await handleNativeHistoryExport(heads([key]), f.env)).status).toBe(
      502,
    );
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });
});
