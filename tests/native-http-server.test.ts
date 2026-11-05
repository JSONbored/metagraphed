import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test, vi } from "vitest";
import type { NativeApiProcess } from "../src/native-api-process.ts";
import type { NativeHttpOptions } from "../src/native-http-server.ts";
import { resolveClientIp } from "../workers/config.ts";

// Exercise real Node networking in a fresh registry. Worker tests replace
// fetch globally; the shared-registry CI pass cannot qualify this boundary.
vi.resetModules();
const { listenNativeApi, trustedHeaders } =
  await import("../src/native-http-server.ts");

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
    process,
    server,
    url: `http://127.0.0.1:${server.address.port}`,
    closed: () => closed,
  };
}

async function fixedClientProxy(target: string, clientIp: string) {
  const proxy = createServer((request, response) => {
    const upstream = httpRequest(
      target,
      {
        method: request.method,
        headers: { ...request.headers, "x-real-ip": clientIp },
      },
      (result) => {
        response.writeHead(result.statusCode!, result.headers);
        result.pipe(response);
      },
    );
    upstream.on("error", (error) => response.destroy(error));
    request.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  );
  return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

function upgradeStatus(
  url: string,
  headers: Record<string, string | string[]>,
) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url,
      { headers: { connection: "Upgrade", upgrade: "websocket", ...headers } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
    request.end();
  });
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

  test("a socket without a peer address cannot retain a forged client identity", () => {
    const headers = trustedHeaders(
      new Headers({
        "cf-connecting-ip": "forged",
        authorization: "Bearer retained",
      }),
      undefined,
      new URL(options.origin),
    );
    assert.equal(headers.has("cf-connecting-ip"), false);
    assert.equal(headers.get("host"), "api.fixture.invalid");
    assert.equal(headers.get("authorization"), "Bearer retained");
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
      { [String("onError")]: null },
      { [String("upgrade")]: null },
      { [String("upgrade")]: { handle: async () => {} } },
      { [String("upgrade")]: { close: async () => {} } },
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

describe("native trusted ingress identity", () => {
  test("requires a bounded list of distinct exact IP addresses", async () => {
    const inherited = Object.assign(
      Object.create({ trustedProxyAddresses: ["127.0.0.1"] }),
      { unexpected: true },
    );
    for (const clientIdentity of [
      null,
      "127.0.0.1",
      [],
      {},
      inherited,
      { trustedProxyAddresses: "127.0.0.1" },
      { trustedProxyAddresses: [] },
      { trustedProxyAddresses: Array(1) },
      { trustedProxyAddresses: Array(33).fill("127.0.0.1") },
      { trustedProxyAddresses: ["127.0.0.1"], extra: true },
      ...[
        null,
        "",
        "*",
        "localhost",
        "127.0.0.1/32",
        "127.000.0.1",
        "[::1]",
        "fe80::1%eth0",
        "0.0.0.0",
        "::",
        "::ffff:0.0.0.0",
      ].map((address) => ({ trustedProxyAddresses: [address] })),
      { trustedProxyAddresses: ["127.0.0.1", "127.0.0.1"] },
      { trustedProxyAddresses: ["127.0.0.1", "::ffff:7f00:1"] },
      { trustedProxyAddresses: ["2001:db8::1", "2001:0DB8:0:0:0:0:0:1"] },
    ]) {
      await assert.rejects(
        listen(async () => new Response(), {
          [String("clientIdentity")]: clientIdentity,
        }),
        /Native.*(identity|proxy)/,
      );
    }
  });

  test("copies the policy and normalizes mapped peers and client addresses", async () => {
    const clientIdentity = { trustedProxyAddresses: ["::ffff:127.0.0.1"] };
    const pending = listen(
      async (request) => {
        assert.equal(request.headers.get("host"), "api.fixture.invalid");
        assert.equal(request.headers.get("authorization"), "Bearer retained");
        assert.equal(request.headers.has("x-real-ip"), false);
        assert.equal(request.headers.has("x-forwarded-for"), false);
        assert.equal(request.headers.has("cf-ray"), false);
        return new Response(resolveClientIp(request));
      },
      { clientIdentity },
    );
    clientIdentity.trustedProxyAddresses[0] = "198.51.100.7";
    clientIdentity.trustedProxyAddresses.push("198.51.100.8");
    const { url } = await pending;
    for (const [claimed, expected] of [
      ["::ffff:192.0.2.1", "192.0.2.1"],
      ["2001:0DB8:0:0:0:0:0:1", "2001:db8::1"],
      ["::fffe:c000:201", "::fffe:c000:201"],
      ["::ff00:c000:201", "::ff00:c000:201"],
    ]) {
      const response = await fetch(url, {
        headers: {
          "x-real-ip": claimed,
          "x-forwarded-for": "spoofed",
          "cf-connecting-ip": "spoofed",
          "cf-ray": "spoofed",
          authorization: "Bearer retained",
        },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), expected);
    }
  });

  test("rejects missing, malformed and duplicate trusted claims before HTTP dispatch", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const { url } = await listen(
      async () => {
        calls++;
        return new Response("unexpected");
      },
      {
        clientIdentity: { trustedProxyAddresses: ["127.0.0.1"] },
        onError: (error) => errors.push(error),
      },
    );
    for (const value of [
      undefined,
      "",
      "invalid",
      "192.0.2.1, 198.51.100.2",
      "fe80::1%lo0",
      "::",
      "0.0.0.0",
    ]) {
      const response = await fetch(url, {
        headers: value === undefined ? {} : { "x-real-ip": value },
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, "invalid_client_identity");
    }
    const duplicate = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        url,
        { headers: { "x-real-ip": ["192.0.2.1", "192.0.2.1"] } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(duplicate, 400);
    assert.equal(calls, 0);
    assert.deepEqual(errors, []);
  });

  test("ignores forwarded claims from untrusted peers", async () => {
    const { url } = await listen(
      async (request) => {
        assert.equal(request.headers.has("x-real-ip"), false);
        assert.equal(request.headers.has("forwarded"), false);
        return new Response(resolveClientIp(request));
      },
      { clientIdentity: { trustedProxyAddresses: ["192.0.2.1"] } },
    );
    const response = await fetch(url, {
      headers: { "x-real-ip": "malformed, claim", forwarded: "for=spoofed" },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /127\.0\.0\.1/);
  });

  test("separates client quotas through proxies which overwrite client claims", async () => {
    const calls = new Map<string, number>();
    const { url } = await listen(
      async (request) => {
        const key = resolveClientIp(request);
        const count = (calls.get(key) ?? 0) + 1;
        calls.set(key, count);
        return new Response(key, { status: count > 1 ? 429 : 200 });
      },
      { clientIdentity: { trustedProxyAddresses: ["127.0.0.1"] } },
    );
    const first = await fixedClientProxy(url, "192.0.2.1");
    const second = await fixedClientProxy(url, "198.51.100.2");
    assert.equal(
      (await fetch(first, { headers: { "x-real-ip": "forged" } })).status,
      200,
    );
    assert.equal(
      (await fetch(second, { headers: { "x-real-ip": "forged" } })).status,
      200,
    );
    assert.equal(
      (await fetch(first, { headers: { "x-real-ip": "another-forgery" } }))
        .status,
      429,
    );
    assert.deepEqual(
      [...calls],
      [
        ["192.0.2.1", 2],
        ["198.51.100.2", 1],
      ],
    );
  });

  test("applies the same trusted identity policy before WebSocket admission", async () => {
    const seen: Request[] = [];
    const errors: unknown[] = [];
    const { url } = await listen(async () => new Response(), {
      clientIdentity: { trustedProxyAddresses: ["127.0.0.1"] },
      onError: (error) => errors.push(error),
      upgrade: {
        async handle(request, _incoming, socket) {
          seen.push(request);
          socket.end(
            "HTTP/1.1 503 Upgrade declined\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          );
        },
        async close() {},
      },
    });
    assert.equal(
      await upgradeStatus(url, {
        "x-real-ip": "::ffff:192.0.2.1",
        "cf-connecting-ip": "forged",
      }),
      503,
    );
    assert.equal(resolveClientIp(seen[0]), "192.0.2.1");
    assert.equal(seen[0].headers.has("x-real-ip"), false);
    const invalidHeaders: Array<Record<string, string | string[]>> = [
      {},
      { "x-real-ip": "forged" },
      { "x-real-ip": ["192.0.2.1", "192.0.2.1"] },
    ];
    for (const headers of invalidHeaders) {
      await assert.rejects(upgradeStatus(url, headers), /socket hang up/);
    }
    assert.equal(seen.length, 1);
    assert.equal(errors.length, 3);
  });
});

test("native upgrades use trusted origin and peer identity, and drain before the process", async () => {
  let seen!: Request;
  let upgradeClosed = 0;
  const fixture = await listen(async () => new Response("ordinary"), {
    upgrade: {
      async handle(request, _incoming, socket) {
        seen = request;
        socket.end(
          "HTTP/1.1 503 Upgrade declined\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
      },
      async close() {
        assert.equal(fixture.closed(), 0);
        upgradeClosed++;
      },
    },
  });
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      fixture.url + "/api/v1/chain/stream?topics=blocks",
      {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          host: "untrusted.invalid",
          "cf-connecting-ip": "forged",
          "x-forwarded-for": "forged",
          "set-cookie": ["first=1", "second=2"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(status, 503);
  assert.equal(
    seen.url,
    "https://api.fixture.invalid/api/v1/chain/stream?topics=blocks",
  );
  assert.match(seen.headers.get("cf-connecting-ip")!, /127\.0\.0\.1/);
  assert.equal(seen.headers.has("x-forwarded-for"), false);
  assert.match(seen.headers.get("set-cookie")!, /first=1/);
  assert.match(seen.headers.get("set-cookie")!, /second=2/);
  await fixture.server.close();
  assert.equal(upgradeClosed, 1);
  assert.equal(fixture.closed(), 1);
});

test("upgrade failures and a no-longer-ready process destroy the connection", async () => {
  const errors: unknown[] = [];
  const fixture = await listen(async () => new Response("ok"), {
    onError: (error) => errors.push(error),
    upgrade: {
      handle: async () => {
        throw new Error("upgrade failed");
      },
      close: async () => {},
    },
  });
  const connect = () =>
    new Promise<void>((resolve, reject) => {
      const request = httpRequest(fixture.url, {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      request.on("response", () => reject(new Error("unexpected response")));
      request.on("error", () => resolve());
      request.end();
    });
  await connect();
  assert.match(String(errors[0]), /upgrade failed/);
  Object.defineProperty(fixture.process, "state", { value: "closing" });
  await connect();
  assert.match(String(errors[1]), /not ready/);
});

test("a bind failure drains the upgrade owner before the shared process", async () => {
  const occupied = await listen(async () => new Response("ok"));
  const calls: string[] = [];
  const process: NativeApiProcess<string, string> = {
    state: "ready",
    fetch: async () => new Response(),
    scheduled: async () => {},
    queue: async () => {},
    close: async () => {
      calls.push("process");
    },
  };
  await assert.rejects(
    listenNativeApi(process, {
      ...options,
      port: occupied.server.address.port,
      onError: () => {
        calls.push("report");
      },
      upgrade: {
        handle: async () => {},
        close: async () => {
          calls.push("upgrade");
          throw new Error("cleanup failed");
        },
      },
    }),
    /EADDRINUSE/,
  );
  assert.deepEqual(calls, ["upgrade", "report", "process"]);
});

test("an upgrade drain failure keeps process resources open until a successful retry", async () => {
  let fail = true;
  const fixture = await listen(async () => new Response("ok"), {
    upgrade: {
      handle: async () => {},
      close: async () => {
        if (fail) throw new Error("upgrade drain incomplete");
      },
    },
  });
  await assert.rejects(fixture.server.close(), /upgrade drain incomplete/);
  assert.equal(fixture.closed(), 0);
  fail = false;
  await fixture.server.close();
  assert.equal(fixture.closed(), 1);
});
