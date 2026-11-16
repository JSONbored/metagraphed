import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { afterEach, describe, test, vi } from "vitest";
import type { NativeApiProcess } from "../src/native-api-process.ts";
import type { NativeHttpOptions } from "../src/native-http-server.ts";

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

// #13118: behind a TLS-terminating reverse proxy the TCP peer is always the
// proxy, so socket-derived identity collapses every client into one for rate
// limits and the per-IP WebSocket cap. The policy below hands identity to the
// proxy's X-Real-IP -- and only for configured peers.
describe("trusted ingress client identity", () => {
  const policy = (...addresses: string[]) => ({
    clientIdentity: { trustedProxyAddresses: addresses },
  });

  test("refuses hostnames, ranges, wildcards, scopes, unspecified and oversized policies at listen time", async () => {
    for (const entries of [
      [],
      ["10.0.0.0/8"],
      ["proxy.internal"],
      ["*"],
      ["fe80::1%eth0"],
      ["0.0.0.0"],
      ["::"],
      [" 127.0.0.1"],
      [""],
      Array.from({ length: 33 }, (_, i) => `198.51.100.${i % 100}`),
      ["300.1.1.1"],
      ["12345::1"],
      [42 as unknown as string],
    ]) {
      await assert.rejects(
        listen(async () => new Response(), {
          clientIdentity: { trustedProxyAddresses: entries },
        }),
      );
    }
  });

  test("an untrusted peer keeps its socket identity and cannot claim one", async () => {
    let seen!: Request;
    const { url } = await listen(async (request) => {
      seen = request;
      return new Response("ok");
    }, policy("198.51.100.7"));
    const response = await fetch(url, {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    assert.equal(response.status, 200);
    assert.match(seen.headers.get("cf-connecting-ip")!, /127\.0\.0\.1/);
    assert.equal(seen.headers.has("x-real-ip"), false);
  });

  test("a trusted proxy's X-Real-IP becomes the client identity, and clients stay apart", async () => {
    const identities: string[] = [];
    const { url } = await listen(async (request) => {
      identities.push(request.headers.get("cf-connecting-ip")!);
      return new Response("ok");
    }, policy("::ffff:127.0.0.1")); // IPv4-mapped entry matches the IPv4 peer
    for (const client of ["203.0.113.9", "::ffff:203.0.113.10"]) {
      const response = await fetch(url, { headers: { "x-real-ip": client } });
      assert.equal(response.status, 200);
    }
    // Distinct clients behind one proxy keep distinct identities (quota
    // separation), and the IPv4-mapped spelling normalizes to IPv4.
    assert.deepEqual(identities, ["203.0.113.9", "203.0.113.10"]);
  });

  test("a trusted proxy that fails its identity obligation is refused before dispatch", async () => {
    let called = 0;
    const { url } = await listen(async () => {
      called += 1;
      return new Response("unexpected");
    }, policy("127.0.0.1"));
    for (const headers of [
      {},
      { "x-real-ip": "attacker.invalid" },
      { "x-real-ip": "0.0.0.0" },
      { "x-real-ip": "::" },
      { "x-real-ip": "203.0.113.9/32" },
      { "x-real-ip": "203.0.113.9, 203.0.113.10" },
    ] as Record<string, string>[]) {
      const response = await fetch(url, { headers });
      assert.equal(response.status, 400);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "invalid_client_identity",
      );
    }
    assert.equal(called, 0);
  });

  test("repeated X-Real-IP headers are one refused claim, not a choice", async () => {
    let called = 0;
    const fixture = await listen(async () => {
      called += 1;
      return new Response("unexpected");
    }, policy("127.0.0.1"));
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        fixture.url,
        { headers: { "x-real-ip": ["203.0.113.9", "203.0.113.10"] } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 400);
    assert.equal(called, 0);
  });

  test("mutating the policy array after listen broadens nothing", async () => {
    const addresses = ["198.51.100.7"];
    let seen!: Request;
    const { url } = await listen(
      async (request) => {
        seen = request;
        return new Response("ok");
      },
      { clientIdentity: { trustedProxyAddresses: addresses } },
    );
    addresses.push("127.0.0.1");
    const response = await fetch(url, {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    assert.equal(response.status, 200);
    assert.match(seen.headers.get("cf-connecting-ip")!, /127\.0\.0\.1/);
  });

  test("upgrades admit a proxied client identity and refuse a missing one before admission", async () => {
    const errors: unknown[] = [];
    let admitted = 0;
    let seen!: Request;
    const fixture = await listen(async () => new Response("ok"), {
      ...policy("127.0.0.1"),
      onError: (error) => errors.push(error),
      upgrade: {
        async handle(request, _incoming, socket) {
          admitted += 1;
          seen = request;
          socket.end(
            "HTTP/1.1 503 Upgrade declined\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          );
        },
        async close() {},
      },
    });
    const upgradeStatus = (headers: Record<string, string>) =>
      new Promise<number | "destroyed">((resolve, reject) => {
        const request = httpRequest(fixture.url, {
          headers: { connection: "Upgrade", upgrade: "websocket", ...headers },
        });
        request.on("response", (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        });
        request.on("error", () => resolve("destroyed"));
        request.on("upgrade", () => reject(new Error("unexpected upgrade")));
        request.end();
      });
    assert.equal(await upgradeStatus({ "x-real-ip": "203.0.113.9" }), 503);
    assert.equal(admitted, 1);
    assert.equal(seen.headers.get("cf-connecting-ip"), "203.0.113.9");
    assert.equal(seen.headers.has("x-real-ip"), false);
    assert.equal(await upgradeStatus({}), "destroyed");
    assert.equal(admitted, 1);
    assert.match(String(errors[0]), /exactly one X-Real-IP/);
  });
});
