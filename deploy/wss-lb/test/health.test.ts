// Run with: cd deploy/wss-lb && npm test
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

async function listen(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForListening(child: ChildProcess) {
  let output = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk: string) => {
    output += chunk;
  });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (output.includes("wss-lb listening")) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited early with ${child.exitCode}: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for server: ${output}`);
}

test("/healthz reports stale upstream pools with HTTP 503", async (t) => {
  const api = http.createServer((req, res) => {
    if (req.url === "/api/v1/rpc/pools") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unavailable" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const apiPort = await listen(api);
  t.after(() => api.close());

  const port = await freePort();
  const server = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      METAGRAPHED_API: `http://127.0.0.1:${apiPort}`,
      PORT: String(port),
      REFRESH_MS: "1000",
      NETWORKS: "finney",
    },
  });
  t.after(() => server.kill());

  await waitForListening(server);

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.deepEqual(body, {
    ok: false,
    stale: true,
    pools: { finney: 0 },
    last_refresh_ms: 0,
  });
});
