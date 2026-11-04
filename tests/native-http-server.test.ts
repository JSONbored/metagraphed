import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, describe, test, vi } from "vitest";
import type { NativeApiProcess } from "../src/native-api-process.ts";
import type { NativeHttpOptions } from "../src/native-http-server.ts";

// Exercise real Node networking in a fresh registry. Worker tests replace
// fetch globally; the shared-registry CI pass cannot qualify this boundary.
vi.resetModules();
const { listenNativeApi } = await import("../src/native-http-server.ts");

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
const options: NativeHttpOptions = {
  origin: "https://api.fixture.invalid",
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBytes: 8,
  requestTimeoutMillis: 1000,
  headersTimeoutMillis: 1000,
  onError() {},
};

async function listen(
  fetch: (request: Request) => Promise<Response>,
  overrides: Partial<NativeHttpOptions> = {},
) {
  let closed = 0;
  const process: NativeApiProcess<string, string> = {
    state: "ready",
    fetch,
    async scheduled() {},
    async queue() {},
    async close() {
      closed += 1;
    },
  };
  const server = await listenNativeApi(process, { ...options, ...overrides });
  cleanup.push(() => server.close());
  return {
    server,
    url: `http://127.0.0.1:${server.address.port}`,
    closed: () => closed,
  };
}

describe("native HTTP boundary", () => {
  test("fixes the origin and derives identity from the socket while retaining authorization", async () => {
    let seen!: Request;
    const { url } = await listen(async (request) => {
      seen = request;
      return new Response("ok");
    });
    const response = await fetch(`${url}/mcp?one=two`, {
      headers: {
        host: "attacker.invalid",
        forwarded: "for=attacker",
        "x-forwarded-for": "attacker",
        "x-forwarded-host": "attacker.invalid",
        "cf-connecting-ip": "attacker",
        "cf-ray": "forged",
        authorization: "Bearer real-token",
        "signature-input": "sig1=()",
      },
    });
    assert.equal(await response.text(), "ok");
    assert.equal(seen.url, "https://api.fixture.invalid/mcp?one=two");
    assert.equal(seen.headers.get("host"), "api.fixture.invalid");
    assert.match(seen.headers.get("cf-connecting-ip")!, /127\.0\.0\.1/);
    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "cf-ray",
    ])
      assert.equal(seen.headers.has(name), false);
    assert.equal(seen.headers.get("authorization"), "Bearer real-token");
    assert.equal(seen.headers.get("signature-input"), "sig1=()");
  });

  test("preserves method, bounded body, status, headers and response bytes", async () => {
    const { url } = await listen(async (request) => {
      assert.equal(request.method, "PATCH");
      assert.equal(await request.text(), "12345678");
      return new Response(Uint8Array.of(0, 128, 255), {
        status: 202,
        headers: { "x-fixture": "yes" },
      });
    });
    const response = await fetch(url, { method: "PATCH", body: "12345678" });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("x-fixture"), "yes");
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      Uint8Array.of(0, 128, 255),
    );
  });

  test("rejects a declared oversized body before dispatch", async () => {
    let called = false;
    const { url } = await listen(async () => {
      called = true;
      return new Response("unexpected");
    });
    const response = await fetch(url, { method: "POST", body: "123456789" });
    assert.equal(response.status, 413);
    assert.equal(called, false);
  });

  test("stops an oversized chunked body while reading", async () => {
    const { server } = await listen(
      async (request) => new Response(await request.text()),
    );
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          { hostname: "127.0.0.1", port: server.address.port, method: "POST" },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode!, body }),
            );
          },
        );
        request.on("error", reject);
        request.write("1234");
        request.end("56789");
      },
    );
    assert.equal(response.status, 413);
    assert.match(response.body, /payload_too_large/);
  });

  test("streams before completion and cancels the source on disconnect", async () => {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    const { url } = await listen(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
            cancel() {
              cancel();
            },
          }),
        ),
    );
    const abort = new AbortController();
    const response = await fetch(url, { signal: abort.signal });
    assert.equal(
      new TextDecoder().decode((await response.body!.getReader().read()).value),
      "first",
    );
    abort.abort();
    await cancelled;
  });

  test("closes the listener and process once", async () => {
    const { server, closed } = await listen(async () => new Response("ok"));
    const first = server.close();
    assert.equal(server.close(), first);
    await first;
    assert.equal(closed(), 1);
  });

  test("refuses incomplete listener configuration and unready composition", async () => {
    for (const override of [
      { origin: "https://fixture.invalid/path" },
      { maxRequestBytes: 0 },
      { hostname: "" },
    ]) {
      await assert.rejects(listen(async () => new Response(), override));
    }
    const process: NativeApiProcess<string, string> = {
      state: "closed",
      async fetch() {
        return new Response();
      },
      async scheduled() {},
      async queue() {},
      async close() {},
    };
    await assert.rejects(listenNativeApi(process, options), /not ready/);
  });

  test("returns the existing error envelope for failed application calls", async () => {
    const errors: unknown[] = [];
    const { url } = await listen(
      async () => {
        throw new Error("private detail");
      },
      {
        onError(error) {
          errors.push(error);
        },
      },
    );
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "internal_error",
    );
    assert.equal((errors[0] as Error).message, "private detail");
  });

  test("preserves the error response when the reporter throws", async () => {
    const { url } = await listen(
      async () => {
        throw new Error("application failed");
      },
      {
        onError() {
          throw new Error("reporter failed");
        },
      },
    );
    const response = await fetch(url);
    assert.equal(response.status, 500);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "internal_error",
    );
  });
});
