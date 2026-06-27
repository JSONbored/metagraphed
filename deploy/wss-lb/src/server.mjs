// WSS load balancer (ADR 0013) — a health-aware WebSocket reverse proxy that
// fans client connections out across the registry's healthy subtensor-wss
// endpoints. Fills the gap the Cloudflare HTTP JSON-RPC proxy explicitly punts
// (rpc-proxy.mjs: "WebSocket JSON-RPC is not available through this HTTP proxy").
//
// Model (cosmos.directory-style): refresh the healthy-endpoint pool from the
// live /api/v1/rpc/pools, and at CONNECT time route each client to the
// freshest/highest-scored upstream, failing over to the next on a failed
// handshake. Mid-session upstream loss closes the client (it reconnects → a new
// upstream) — JSON-RPC subscription state can't be transparently moved.
//
// INTEGRATION-PENDING: the live ws-piping is verified on deploy; the pure
// upstream selection is unit-tested (test/select.test.mjs). Public behind
// Cloudflare DNS for TLS/DDoS. Env: METAGRAPHED_API, PORT, REFRESH_MS,
// MAX_BLOCK_LAG, NETWORKS, HANDSHAKE_TIMEOUT_MS.
import http from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { selectWssUpstreams } from "./select.mjs";

const API = process.env.METAGRAPHED_API || "https://api.metagraph.sh";
const PORT = Number(process.env.PORT || 8080);
const REFRESH_MS = Number(process.env.REFRESH_MS || 30000);
const MAX_BLOCK_LAG = Number(process.env.MAX_BLOCK_LAG || 50);
const HANDSHAKE_TIMEOUT_MS = Number(process.env.HANDSHAKE_TIMEOUT_MS || 10000);
const NETWORKS = (process.env.NETWORKS || "finney,test")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);

let poolsArtifact = null;
let lastRefresh = 0;

async function refresh() {
  try {
    const res = await fetch(`${API}/api/v1/rpc/pools`, {
      signal: AbortSignal.timeout(10000),
      headers: { "user-agent": "metagraphed-wss-lb/1.0" },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    const artifact = Array.isArray(body?.pools)
      ? body
      : Array.isArray(body?.data?.pools)
        ? body.data
        : null;
    if (artifact) {
      poolsArtifact = artifact;
      lastRefresh = Date.now();
    }
  } catch (e) {
    log("refresh failed:", String(e?.message || e).slice(0, 160));
  }
}

function poolFor(network) {
  return selectWssUpstreams(poolsArtifact, network, {
    maxBlockLag: MAX_BLOCK_LAG,
  });
}

// Connect-time failover: try upstreams in order until one completes its
// handshake, then pipe bidirectionally. Client messages sent before the upstream
// opens are buffered (the client sees its leg as open immediately).
//
// The client listeners are attached ONCE — `up` is reassigned per attempt via
// closure. Re-attaching them per retry would stack handlers on failover (double
// send + MaxListenersExceeded). `clientClosed` stops retrying once the client is
// gone, so a vanished client can't keep dialing fresh upstreams.
function proxy(client, upstreams) {
  let up = null;
  let opened = false;
  let clientClosed = false;
  const pending = [];

  client.on("message", (data, isBinary) => {
    if (opened && up && up.readyState === WebSocket.OPEN)
      up.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  client.on("close", () => {
    clientClosed = true;
    try {
      up?.close();
    } catch {
      /* noop */
    }
  });
  client.on("error", () => {
    clientClosed = true;
    try {
      up?.terminate();
    } catch {
      /* noop */
    }
  });

  const tryUpstream = (attempt) => {
    if (clientClosed) return;
    if (attempt >= upstreams.length) {
      try {
        client.close(1013, "no upstream available");
      } catch {
        /* already closed */
      }
      return;
    }
    up = new WebSocket(upstreams[attempt], {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    up.on("open", () => {
      opened = true;
      for (const [data, isBinary] of pending)
        up.send(data, { binary: isBinary });
      pending.length = 0;
      up.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN)
          client.send(data, { binary: isBinary });
      });
    });
    up.on("close", () => {
      if (opened) {
        try {
          client.close();
        } catch {
          /* noop */
        }
      } else {
        tryUpstream(attempt + 1); // handshake never completed → next
      }
    });
    up.on("error", () => {
      if (opened) {
        try {
          client.close();
        } catch {
          /* noop */
        }
      } else {
        try {
          up.terminate();
        } catch {
          /* noop */
        }
        tryUpstream(attempt + 1);
      }
    });
  };

  tryUpstream(0);
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/") {
    const pools = Object.fromEntries(
      NETWORKS.map((n) => [n, poolFor(n).length]),
    );
    const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS * 3;
    res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: !stale, pools, last_refresh_ms: lastRefresh }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const network = (req.url || "/")
    .replace(/^\/+/, "")
    .split("?")[0]
    .split("/")[0];
  if (!NETWORKS.includes(network)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstreams = poolFor(network);
  if (!upstreams.length) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => proxy(client, upstreams));
});

await refresh();
setInterval(refresh, REFRESH_MS);
server.listen(PORT, () =>
  log(
    `wss-lb listening :${PORT} · networks=${NETWORKS.join(",")} · api=${API}`,
  ),
);
