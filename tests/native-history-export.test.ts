import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
function fixture(checksum = true, originalEtag = etag) {
  const f = historyAssetsFixture([
    { key, etag: originalEtag, chunks: [raw.slice(0, 3), raw.slice(3)] },
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
  return {
    ...f,
    env,
    object,
    publish() {
      f.publish();
      env.NATIVE_HISTORY_ASSET_RELEASE = f.env.HISTORY_ASSET_RELEASE;
    },
  };
}
const request = (input: unknown, secret = "existing-producer-secret") =>
  new Request("https://example.com/api/v1/internal/state-export", {
    method: "POST",
    headers: { "x-state-export-token": secret },
    body: JSON.stringify(input),
  });
afterEach(() => vi.restoreAllMocks());

describe("bounded native Parquet footer batches", () => {
  const footers = { kind: "native-history", operation: "footers", keys: [key] };

  it("preserves exact bytes and identities through the existing credential and proxy", async () => {
    const f = fixture();
    const env = {
      DATA_API: {
        fetch: (incoming: Request) => handleD1StateExport(incoming, f.env),
      },
    } as unknown as Env;
    expect(
      (await handleRequest(request(footers, "wrong"), env, {})).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleRequest(request(footers), env, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      objects: [
        {
          key,
          etag,
          bytes: raw.length,
          sha256: assetHash(raw),
          offset: 0,
          data: Buffer.from(raw).toString("base64"),
        },
      ],
    });
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });

  it.each([undefined, 131072] as const)(
    "bounds shared metadata, total bytes, order and concurrency with footerBytes=%s",
    async (footerBytes) => {
      const tail = footerBytes ?? 65536,
        count = 1048576 / tail;
      const keys = Array.from({ length: count }, (_, i) =>
        key.replace("00000-", `${String(i).padStart(5, "0")}-`),
      );
      let active = 0,
        maximum = 0;
      const describe = vi.fn(async (key: string) => ({
        key,
        etag,
        bytes: 300000,
        sha256: "c".repeat(64),
      }));
      const read = vi.fn(
        async (
          _key: string,
          identity: string,
          offset: number,
          length: number,
        ) => {
          expect(identity).toBe(etag);
          expect(offset).toBe(300000 - tail);
          expect(length).toBe(tail);
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
          return new Uint8Array(length).fill(7).buffer;
        },
      );
      const factory = vi
        .spyOn(assets, "historyAssetSource")
        .mockReturnValue({ describe, read });
      const response = await handleNativeHistoryExport(
        { ...footers, keys, footerBytes },
        {},
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        objects: { key: string; offset: number; data: string }[];
      };
      expect(body.objects.map((o: { key: string }) => o.key)).toEqual(keys);
      expect(
        body.objects.every(
          (o: { offset: number; data: string }) =>
            o.offset === 300000 - tail &&
            Buffer.from(o.data, "base64").equals(Buffer.alloc(tail, 7)),
        ),
      ).toBe(true);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(describe).toHaveBeenCalledTimes(count);
      expect(read).toHaveBeenCalledTimes(count);
      expect(maximum).toBeLessThanOrEqual(4);
    },
  );

  it("rejects malformed or duplicate batches before storage access", async () => {
    const f = fixture();
    for (const input of [
      { ...footers, keys: [] },
      { ...footers, keys: Array(17).fill(key) },
      { ...footers, keys: [key, key] },
      { ...footers, keys: [key.replace(".parquet", ".page-index.json")] },
      { ...footers, verify: true },
      { ...footers, footerBytes: 0 },
      { ...footers, footerBytes: 65537 },
      { ...footers, footerBytes: 262144 },
      {
        ...footers,
        footerBytes: 131072,
        keys: Array.from({ length: 9 }, (_, i) =>
          key.replace("00000-", `${String(i).padStart(5, "0")}-`),
        ),
      },
    ])
      expect((await handleNativeHistoryExport(input, f.env)).status).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not return a partial batch for unmigrated, corrupt or truncated objects", async () => {
    const f = fixture();
    expect(
      (
        await handleNativeHistoryExport(
          { ...footers, keys: [key.replace("00000-", "00001-")] },
          f.env,
        )
      ).status,
    ).toBe(502);
    const missingChecksum = fixture(false);
    expect(
      (await handleNativeHistoryExport(footers, missingChecksum.env)).status,
    ).toBe(502);
    vi.spyOn(assets, "historyAssetSource").mockReturnValueOnce({
      describe: async () => ({
        key,
        etag,
        bytes: raw.length,
        sha256: assetHash(raw),
      }),
      read: async () => new ArrayBuffer(0),
    });
    expect((await handleNativeHistoryExport(footers, f.env)).status).toBe(502);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
  });
});

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
      { ...head, release: "" },
      { ...head, release: "https://untrusted.invalid/file" },
      { ...head, release: `${"a".repeat(64)}:0` },
      { ...head, release: `${"a".repeat(64)}:524289` },
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

describe("immutable release verification without a migration Worker", () => {
  const verify = { ...head, operation: "verify" };
  const digest = createHash("md5").update(raw).digest("hex");

  it("authenticates release selection and verifies both original hashes without changing the serving release", async () => {
    const f = fixture(true, digest);
    const release = f.env.NATIVE_HISTORY_ASSET_RELEASE;
    f.env.NATIVE_HISTORY_ASSET_RELEASE = `${"a".repeat(64)}:100`;
    const input = { ...verify, release };
    expect(
      (await handleD1StateExport(request(input, "wrong"), f.env)).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleD1StateExport(request(input), f.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      verified: true,
      object: { key, etag: digest, bytes: raw.length, sha256: assetHash(raw) },
    });
    expect(f.env.NATIVE_HISTORY_ASSET_RELEASE).toBe(`${"a".repeat(64)}:100`);
    expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    expect((await handleD1StateExport(request(verify), f.env)).status).toBe(
      502,
    );
    for (const operation of [
      head,
      range,
      { kind: "native-history", operation: "heads", keys: [key] },
    ]) {
      const response = await handleD1StateExport(
        request({
          ...operation,
          release,
          ...(operation.operation === "range" ? { etag: digest } : {}),
        }),
        f.env,
      );
      expect(response.status).toBe(operation.operation === "range" ? 206 : 200);
    }
  });

  it("rejects an original SHA256 or MD5 mismatch instead of trusting chunk hashes", async () => {
    for (const badSha of [true, false]) {
      const f = fixture(true, badSha ? digest : etag);
      if (badSha) Object.assign(f.object, { sha256: "0".repeat(64) });
      f.publish();
      const response = await handleD1StateExport(request(verify), f.env);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "native history original checksum mismatch",
      });
      expect(f.env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    }
  });

  it("hashes a multi-range original sequentially and does not acknowledge a failed later read", async () => {
    const bytes = new Uint8Array(8 * 1024 * 1024 + 7).fill(17);
    const object = {
      key,
      etag: createHash("md5").update(bytes).digest("hex"),
      bytes: bytes.length,
      sha256: assetHash(bytes),
    };
    const read = vi.fn(
      async (_key: string, _etag: string, offset: number, length: number) =>
        bytes.slice(offset, offset + length).buffer,
    );
    vi.spyOn(assets, "historyAssetSource").mockReturnValue({
      describe: async () => object,
      read,
    });
    expect((await handleNativeHistoryExport(verify, {})).status).toBe(200);
    expect(read.mock.calls.map((c) => c.slice(2))).toEqual([
      [0, 8 * 1024 * 1024],
      [8 * 1024 * 1024, 7],
    ]);
    read.mockClear();
    read.mockImplementationOnce(
      async () => bytes.slice(0, 8 * 1024 * 1024).buffer,
    );
    read.mockRejectedValueOnce(new Error("later chunk unavailable"));
    const failed = await handleNativeHistoryExport(verify, {});
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({
      error: "native history static source is unavailable",
    });
    expect(read).toHaveBeenCalledTimes(2);
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

describe("bounded full-checksum metadata batches", () => {
  const batch = (keys: string[]) => ({
    kind: "native-history",
    operation: "heads",
    verify: true,
    keys,
  });
  const keys = Array.from({ length: 6 }, (_, index) =>
    key.replace("00000-", `${String(index).padStart(5, "0")}-`),
  );
  const digest = createHash("md5").update(raw).digest("hex");
  const object = (key: string) => ({
    key,
    etag: digest,
    bytes: raw.length,
    sha256: assetHash(raw),
  });

  it("verifies multiple published originals through the existing authenticated proxy", async () => {
    const inputs = keys.slice(0, 3).map((key, index) => {
      const bytes = raw.slice(index);
      return {
        key,
        bytes,
        etag: createHash("md5").update(bytes).digest("hex"),
        chunks: [bytes.slice(0, 2), bytes.slice(2)],
      };
    });
    const f = historyAssetsFixture(inputs);
    for (const input of inputs)
      Object.assign(
        f.shards[assetHash(input.key).slice(0, 2)].objects[
          assetHash(input.key)
        ],
        { sha256: assetHash(input.bytes) },
      );
    f.publish();
    const archive = { get: vi.fn() };
    const env = {
      STATE_EXPORT_SECRET: "existing-producer-secret",
      NATIVE_HISTORY_ASSETS: f.env.HISTORY_ASSETS,
      NATIVE_HISTORY_ASSET_RELEASE: `${"f".repeat(64)}:100`,
      METAGRAPH_ARCHIVE: archive,
    };
    const input = {
      ...batch(inputs.map((i) => i.key)),
      release: f.env.HISTORY_ASSET_RELEASE,
    };
    expect(
      (await handleD1StateExport(request(input, "wrong"), env)).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleRequest(
      request(input),
      {
        DATA_API: { fetch: (req: Request) => handleD1StateExport(req, env) },
      } as unknown as Env,
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      verified: true,
      objects: inputs.map((i) => ({
        key: i.key,
        etag: i.etag,
        bytes: i.bytes.length,
        sha256: assetHash(i.bytes),
      })),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(archive.get).not.toHaveBeenCalled();
    expect(env.NATIVE_HISTORY_ASSET_RELEASE).toBe(`${"f".repeat(64)}:100`);
  });

  it("rejects invalid flags, duplicates and missing or corrupt originals without a partial acknowledgment", async () => {
    const f = fixture(true, digest);
    for (const input of [
      { ...batch([key]), verify: false },
      { ...batch([key]), verify: "true" },
      batch([key, key]),
      batch([]),
    ]) {
      expect((await handleD1StateExport(request(input), f.env)).status).toBe(
        400,
      );
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect(
      (await handleD1StateExport(request(batch([key, keys[1]])), f.env)).status,
    ).toBe(502);
    const bad = fixture(true, etag);
    expect(
      (await handleD1StateExport(request(batch([key])), bad.env)).status,
    ).toBe(502);
  });

  it("caps payload concurrency at four, stops queued reads and drains started reads on failure", async () => {
    const pending = new Map<
      string,
      { resolve: (value: ArrayBuffer) => void; reject: (error: Error) => void }
    >();
    const read = vi.fn(
      (key: string) =>
        new Promise<ArrayBuffer>((resolve, reject) =>
          pending.set(key, { resolve, reject }),
        ),
    );
    vi.spyOn(assets, "historyAssetSource").mockReturnValue({
      describe: async (key) => object(key),
      read,
    });
    let completed = false;
    const response = handleNativeHistoryExport(batch(keys), {}).then((r) => {
      completed = true;
      return r;
    });
    await vi.waitFor(() => expect(pending.size).toBe(4));
    pending.get(keys[0])!.reject(new Error("failed payload"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    for (const key of keys.slice(1, 4))
      pending.get(key)!.resolve(raw.slice().buffer);
    expect((await response).status).toBe(502);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("shares the 128 MiB original-byte budget across the batch before another payload read", async () => {
    const range = new Uint8Array(8 * 1024 * 1024);
    const sha = createHash("sha256"),
      md5 = createHash("md5");
    for (let i = 0; i < 16; i++) {
      sha.update(range);
      md5.update(range);
    }
    const large = {
      key,
      bytes: 128 * 1024 * 1024,
      sha256: sha.digest("hex"),
      etag: md5.digest("hex"),
    };
    const read = vi.fn(async (_key: string) => range.buffer);
    vi.spyOn(assets, "historyAssetSource").mockReturnValue({
      describe: async (key) => (key === large.key ? large : object(key)),
      read,
    });
    expect((await handleNativeHistoryExport(batch([key]), {})).status).toBe(
      200,
    );
    expect(read).toHaveBeenCalledTimes(count);
    read.mockClear();
    expect(
      (await handleNativeHistoryExport(batch([key, keys[1]]), {})).status,
    ).toBe(502);
    expect(read).toHaveBeenCalledTimes(count);
    expect(read.mock.calls.every((call) => call[0] === key)).toBe(true);
  });
});
