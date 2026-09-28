import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../workers/api.ts";
import {
  handleNativeStoreExport,
  handleNativeStoreExportRequest,
} from "../src/native-store-export.ts";

const raw = "immutable native content";
const sha256 = createHash("sha256").update(raw).digest("hex");
const asset = { sha256, bytes: raw.length };
const input = {
  kind: "native-store",
  partition: "a",
  operation: "read",
  ...asset,
};
const verification = {
  kind: "native-store",
  partition: "a",
  operation: "verify",
  assets: [asset],
};
function fixture(response = () => new Response(raw)) {
  const fetch = vi.fn(async (_request: Request) => response());
  const r2 = vi.fn(() => {
    throw new Error("R2 must not be read");
  });
  const env = {
    STATE_EXPORT_SECRET: "producer-secret",
    NATIVE_HISTORY_ASSETS_a: { fetch },
    METAGRAPH_ARCHIVE: { get: r2 },
  };
  return { fetch, r2, env };
}
const request = (body: unknown, token = "producer-secret") =>
  new Request("https://example.com/api/v1/internal/native-store-export", {
    method: "POST",
    headers: { "x-state-export-token": token },
    body: JSON.stringify(body),
  });

describe("existing private native store readback", () => {
  it("reads a bounded batch in caller order and verifies every asset", async () => {
    const values = [Buffer.from("first"), Buffer.from("second")];
    const assets = values.map((raw) => ({
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
    }));
    const fetch = vi.fn(async (request: Request) => {
      const index = assets.findIndex((asset) =>
        request.url.endsWith(`/${asset.sha256}.mgpack`),
      );
      return new Response(values[index]);
    });
    const response = await handleNativeStoreExport(
      { ...verification, operation: "read-many", assets },
      { NATIVE_HISTORY_ASSETS_a: { fetch } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(values.reduce((n, raw) => n + raw.length, 0)),
    );
    expect(response.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(Buffer.concat(values)).digest("hex"),
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.concat(values),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const assets of [
      [asset, asset],
      [{ ...asset, bytes: 512 * 1024 + 1 }],
    ]) {
      expect(
        (
          await handleNativeStoreExport(
            { ...verification, operation: "read-many", assets },
            {},
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await handleNativeStoreExport(
          { ...verification, operation: "read-many" },
          fixture(() => new Response("corrupt")).env,
        )
      ).status,
    ).toBe(502);
  });

  it("requires the existing export credential before touching the selected binding", async () => {
    const f = fixture();
    expect(
      (
        await handleRequest(
          request(input, "wrong"),
          f.env as unknown as Env,
          {},
        )
      ).status,
    ).toBe(401);
    expect(f.fetch).not.toHaveBeenCalled();
    const response = await handleRequest(
      request(input),
      f.env as unknown as Env,
      {},
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-length")).toBe(String(raw.length));
    expect(response.headers.get("x-content-sha256")).toBe(sha256);
    expect(await response.text()).toBe(raw);
    const incoming = f.fetch.mock.calls[0][0];
    expect(incoming.url).toBe(
      `https://history-assets.invalid/${sha256}.mgpack`,
    );
    expect(incoming.headers.get("accept-encoding")).toBe("identity");
    expect(incoming.redirect).toBe("manual");
    expect(f.r2).not.toHaveBeenCalled();
  });

  it("keeps the existing internal rate limit before asset reads", async () => {
    const f = fixture();
    const response = await handleRequest(
      request(input),
      {
        ...f.env,
        INTERNAL_SYNC_RATE_LIMITER: { limit: async () => ({ success: false }) },
      } as unknown as Env,
      {},
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing credentials, unsupported methods and unbounded or malformed bodies", async () => {
    const f = fixture();
    expect(
      (await handleNativeStoreExportRequest(request(input), undefined)).status,
    ).toBe(503);
    expect(
      (
        await handleNativeStoreExportRequest(
          new Request(request(input).url, {
            headers: { "x-state-export-token": "producer-secret" },
          }),
          f.env,
        )
      ).status,
    ).toBe(405);
    for (const body of ["bad json", "x".repeat(8193)]) {
      expect(
        (
          await handleNativeStoreExportRequest(
            new Request(request(input).url, {
              method: "POST",
              headers: { "x-state-export-token": "producer-secret" },
              body,
            }),
            f.env,
          )
        ).status,
      ).toBe(400);
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("reads a publisher manifest by its exact compressed-byte identity", async () => {
    const f = fixture(
      () =>
        new Response(raw, {
          headers: {
            "content-length": String(raw.length),
            "content-encoding": "identity",
          },
        }),
    );
    const response = await handleNativeStoreExport(
      { ...input, manifest: true },
      f.env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(raw);
    expect(f.fetch.mock.calls[0][0].url).toBe(
      `https://history-assets.invalid/__native_publisher__/${sha256}.json.gz`,
    );
  });

  it("verifies a batch near storage and returns only small exact receipts", async () => {
    const f = fixture();
    const response = await handleNativeStoreExport(verification, f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      partition: "a",
      verified: true,
      assets: [asset],
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.r2).not.toHaveBeenCalled();
  });

  it("rejects invalid scopes, duplicates and byte budgets before I/O", async () => {
    const f = fixture();
    for (const bad of [
      null,
      { ...input, kind: "other" },
      { ...input, partition: "10" },
      { ...input, sha256: "../secret" },
      { ...input, extra: true },
      { ...input, bytes: 0 },
      { ...input, bytes: 24 * 1024 * 1024 + 1, manifest: true },
      { ...input, bytes: 512 * 1024 + 1 },
      { ...verification, assets: [] },
      { ...verification, assets: [asset, asset] },
      {
        ...verification,
        assets: Array.from({ length: 17 }, (_, i) => ({
          sha256: i.toString(16).padStart(64, "0"),
          bytes: 512 * 1024,
        })),
      },
      { ...verification, assets: Array.from({ length: 33 }, () => asset) },
    ])
      expect((await handleNativeStoreExport(bad, f.env)).status).toBe(400);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("cannot fall back when the exact existing partition is absent", async () => {
    for (const env of [undefined, null, {}, { NATIVE_HISTORY_ASSETS_a: {} }])
      expect((await handleNativeStoreExport(input, env)).status).toBe(503);
  });

  it("rejects missing, oversized, truncated, encoded and corrupt bodies", async () => {
    for (const response of [
      () => new Response(raw, { status: 404 }),
      () => new Response(null),
      () => new Response(raw, { headers: { "content-length": "invalid" } }),
      () => new Response(raw, { headers: { "content-length": "1" } }),
      () => new Response(raw, { headers: { "content-encoding": "gzip" } }),
      () => new Response(raw + "extra"),
      () => new Response(raw.slice(1)),
      () => new Response("x".repeat(raw.length)),
      () => {
        throw new Error("private provider details");
      },
    ]) {
      const f = fixture(response);
      const actual = await handleNativeStoreExport(input, f.env);
      expect(actual.status).toBe(502);
      expect(await actual.json()).toEqual({
        error: "native store content is unavailable or changed",
      });
      expect(f.r2).not.toHaveBeenCalled();
    }
  });

  it("rejects asset redirects without following them or accepting their body", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const cancel = vi.fn();
      const f = fixture(
        () =>
          new Response(new ReadableStream({ cancel }), {
            status,
            headers: { location: "https://unexpected.invalid/asset" },
          }),
      );
      const response = await handleNativeStoreExport(input, f.env);
      expect(response.status).toBe(502);
      expect(f.fetch).toHaveBeenCalledTimes(1);
      expect(f.fetch.mock.calls[0][0].redirect).toBe("manual");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(f.r2).not.toHaveBeenCalled();
    }
  });

  it("stops a verification batch on the first failure and cancels its stream", async () => {
    const cancel = vi.fn();
    const f = fixture(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(raw + "extra"));
            },
            cancel,
          }),
        ),
    );
    const actual = await handleNativeStoreExport(
      {
        ...verification,
        assets: [asset, { ...asset, sha256: "f".repeat(64) }],
      },
      f.env,
    );
    expect(actual.status).toBe(502);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("handles multi-chunk byte streams and reads each asset sequentially", async () => {
    const second = "second",
      hash = createHash("sha256").update(second).digest("hex");
    let active = 0,
      peak = 0;
    const fetch = vi.fn(async (r: Request) => {
      active++;
      peak = Math.max(peak, active);
      const bytes = new TextEncoder().encode(
        r.url.includes(sha256) ? raw : second,
      );
      return new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(bytes.slice(0, 2));
            await new Promise((resolve) => setTimeout(resolve, 1));
            c.enqueue(bytes.slice(2));
            c.close();
            active--;
          },
        }),
      );
    });
    const response = await handleNativeStoreExport(
      {
        ...verification,
        assets: [asset, { sha256: hash, bytes: second.length }],
      },
      { NATIVE_HISTORY_ASSETS_a: { fetch } },
    );
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
  });
});
