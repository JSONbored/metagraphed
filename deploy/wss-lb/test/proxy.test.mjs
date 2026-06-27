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

function lbServer(upstreams) {
  return new Promise((resolve) => {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (client) =>
      proxy(client, upstreams, { handshakeTimeout: 2000 }),
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
    c.on("open", () => c.send("ping")); // pre-open send → the buffered/crash path
    c.on("message", (d) => {
      c.close();
      resolve(d.toString());
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), 8000);
  });
  assert.equal(echoed, "ping");
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
