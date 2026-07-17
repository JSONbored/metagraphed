// Integration tests for the failover proxy against REAL ws sockets — needs the
// `ws` dep installed (npm install in deploy/wss-lb). Run:
//   node --test deploy/wss-lb/test/
//
// These reproduce the failover defects the adversarial review found: on a failed
// handshake ws emits BOTH 'error' and 'close', so a naive proxy advances twice
// (duplicate dial) and can flush `pending` into a still-CONNECTING socket, an
// uncaught exception that crashes the whole process.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { WebSocket, WebSocketServer } from "ws";

import { proxy } from "../src/proxy.mjs";

function echoServer() {
  return new Promise((resolve) => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections += 1;
      ws.on("message", (d, isBinary) => ws.send(d, { binary: isBinary }));
    });
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        get connections() {
          return connections;
        },
        close: () => new Promise((r) => http.close(r)),
      });
    });
  });
}

function lbServer(upstreams, proxyOpts = {}) {
  return new Promise((resolve) => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (client) =>
      proxy(client, upstreams, { handshakeTimeout: 2000, ...proxyOpts }),
    );
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise((r) => http.close(r)),
      });
    });
  });
}

// A guaranteed-dead upstream: bind an ephemeral port, then free it.
async function deadUrl() {
  const s = await echoServer();
  const u = s.url;
  await s.close();
  return u;
}

test("failover: dead upstream then good → one dial, echo works, no crash", async () => {
  const good = await echoServer();
  const lb = await lbServer([await deadUrl(), good.url]);
  const echoed = await new Promise((resolve, reject) => {
    const c = new WebSocket(lb.url);
    c.on("open", () =>
      c.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system_health" }),
      ),
    ); // pre-open send → the buffered/crash path
    c.on("message", (d) => {
      c.close();
      resolve(d.toString());
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });
  assert.deepEqual(JSON.parse(echoed), {
    jsonrpc: "2.0",
    id: 1,
    method: "system_health",
  });
  assert.equal(good.connections, 1); // not 2 — no duplicate dial
  await lb.close();
  await good.close();
});

test("all upstreams dead → client closed with 1013", async () => {
  const lb = await lbServer([await deadUrl(), await deadUrl()]);
  const code = await new Promise((resolve) => {
    const c = new WebSocket(lb.url);
    c.on("close", (closeCode) => resolve(closeCode));
    setTimeout(() => resolve(-1), 8000);
  });
  assert.equal(code, 1013);
  await lb.close();
});

test("all upstreams dead → onNoUpstream fires exactly once (for Sentry aggregate reporting)", async () => {
  let calls = 0;
  const lb = await lbServer([await deadUrl(), await deadUrl()], {
    onNoUpstream: () => {
      calls += 1;
    },
  });
  await new Promise((resolve) => {
    const c = new WebSocket(lb.url);
    c.on("close", () => resolve());
    setTimeout(resolve, 8000);
  });
  assert.equal(calls, 1);
  await lb.close();
});

test("onNoUpstream is never called on a successful failover (only on total exhaustion)", async () => {
  let calls = 0;
  const good = await echoServer();
  const lb = await lbServer([await deadUrl(), good.url], {
    onNoUpstream: () => {
      calls += 1;
    },
  });
  await new Promise((resolve, reject) => {
    const c = new WebSocket(lb.url);
    c.on("open", () => c.close());
    c.on("close", resolve);
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });
  assert.equal(calls, 0);
  await lb.close();
  await good.close();
});

test("security: unsafe and oversized client RPC frames do not reach upstream", async () => {
  const upstreamMessages = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      upstreamMessages.push(d.toString());
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "accepted" }));
    });
  });
  const upstream = await new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () =>
      resolve(`ws://127.0.0.1:${http.address().port}`),
    ),
  );
  const lb = await lbServer([upstream]);

  const replies = await new Promise((resolve, reject) => {
    const seen = [];
    const c = new WebSocket(lb.url);
    c.on("open", () => {
      c.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "author_submitExtrinsic",
        }),
      );
      c.send(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "system_health" }),
      );
      c.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "state_call",
          params: ["x".repeat(70000)],
        }),
      );
    });
    c.on("message", (d) => {
      seen.push(JSON.parse(d.toString()));
      if (seen.length === 3) {
        c.close();
        resolve(seen);
      }
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });

  assert.ok(
    replies.some(
      (reply) =>
        reply.error?.message ===
        "RPC method is not allowed through this proxy: author_submitExtrinsic",
    ),
  );
  assert.ok(
    replies.some(
      (reply) =>
        reply.error?.message ===
        "RPC request body is too large for the read-only proxy.",
    ),
  );
  assert.ok(
    replies.some(
      (reply) =>
        reply.jsonrpc === "2.0" &&
        reply.id === 99 &&
        reply.result === "accepted",
    ),
  );
  assert.deepEqual(
    upstreamMessages.map((m) => JSON.parse(m).method),
    ["system_health"],
  );

  await lb.close();
  await new Promise((resolve) => http.close(resolve));
});

test("security: nested non-scalar RPC ids are not reflected in errors", async () => {
  const good = await echoServer();
  const lb = await lbServer([good.url]);
  const nestedId = "[".repeat(5000) + "null" + "]".repeat(5000);
  const payload = `{"jsonrpc":"2.0","id":${nestedId},"method":"author_submitExtrinsic"}`;

  const reply = await new Promise((resolve, reject) => {
    const c = new WebSocket(lb.url);
    c.on("open", () => {
      c.send(payload);
    });
    c.on("message", (d) => {
      c.close();
      resolve(JSON.parse(d.toString()));
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });

  assert.equal(reply.id, null);
  assert.equal(reply.error?.code, -32601);
  assert.equal(good.connections, 1);

  await lb.close();
  await good.close();
});

test("security: storage subscriptions are rejected before reaching upstream", async () => {
  const upstreamMessages = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      upstreamMessages.push(d.toString());
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "accepted" }));
    });
  });
  const upstream = await new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () =>
      resolve(`ws://127.0.0.1:${http.address().port}`),
    ),
  );
  const lb = await lbServer([upstream]);

  async function rejectedStorageReply(method, params) {
    return await new Promise((resolve, reject) => {
      const c = new WebSocket(lb.url);
      c.on("open", () =>
        c.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
        ),
      );
      c.on("message", (d) => {
        c.close();
        resolve(JSON.parse(d.toString()));
      });
      c.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 8000);
    });
  }

  const subscribeReply = await rejectedStorageReply("state_subscribeStorage", [
    ["0x" + "00".repeat(32)],
  ]);
  const unsubscribeReply = await rejectedStorageReply(
    "state_unsubscribeStorage",
    ["0xSUBID"],
  );

  assert.equal(subscribeReply.error?.code, -32601);
  assert.equal(
    subscribeReply.error?.message,
    "RPC method is not allowed through this proxy: state_subscribeStorage",
  );
  assert.equal(unsubscribeReply.error?.code, -32601);
  assert.equal(
    unsubscribeReply.error?.message,
    "RPC method is not allowed through this proxy: state_unsubscribeStorage",
  );
  assert.deepEqual(upstreamMessages, []);

  await lb.close();
  await new Promise((resolve) => http.close(resolve));
});

test("subscriptions: read-only subscribe frames are relayed to upstream", async () => {
  const upstreamMethods = [];
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      upstreamMethods.push(JSON.parse(d.toString()).method);
      // emulate the subscription handshake + a notification (two upstream frames)
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xSUBID" }));
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "chain_newHead",
          params: { subscription: "0xSUBID", result: { number: "0x1" } },
        }),
      );
    });
  });
  const upstream = await new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () =>
      resolve(`ws://127.0.0.1:${http.address().port}`),
    ),
  );
  const lb = await lbServer([upstream]);

  const seen = await new Promise((resolve, reject) => {
    const c = new WebSocket(lb.url);
    c.on("open", () =>
      c.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "chain_subscribeNewHeads",
        }),
      ),
    );
    const messages = [];
    c.on("message", (d) => {
      messages.push(JSON.parse(d.toString()));
      if (messages.length === 2) {
        c.close();
        resolve(messages);
      }
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });

  assert.deepEqual(upstreamMethods, ["chain_subscribeNewHeads"]);
  assert.deepEqual(seen, [
    { jsonrpc: "2.0", id: 1, result: "0xSUBID" },
    {
      jsonrpc: "2.0",
      method: "chain_newHead",
      params: { subscription: "0xSUBID", result: { number: "0x1" } },
    },
  ]);

  await lb.close();
  await new Promise((resolve) => http.close(resolve));
});
