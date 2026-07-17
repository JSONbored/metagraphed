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
// MAX_BLOCK_LAG, NETWORKS, HANDSHAKE_TIMEOUT_MS. Optionally SENTRY_DSN/
// SENTRY_ENVIRONMENT/SENTRY_RELEASE (silently no-ops if SENTRY_DSN is unset
// -- see src/observability.mjs).
import http from "node:http";

import { WebSocketServer } from "ws";

import { MAX_RPC_BODY_BYTES } from "./rpc-policy.mjs";
import { proxy } from "./proxy.mjs";
import { selectWssUpstreams } from "./select.mjs";
import {
  initSentry,
  computeNoUpstreamWindowUpdate,
  reportNoUpstreamWindow,
  reportPoolStale,
} from "./observability.mjs";

initSentry();

// Numeric env with a NaN/positivity guard: Number(process.env.X || d) returns NaN
// for a non-numeric string (the `|| d` only catches empty/unset), which would
// poison the refresh timer, the /healthz staleness gate, and the block-lag filter.
const envInt = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const API = process.env.METAGRAPHED_API || "https://api.metagraph.sh";
const PORT = envInt("PORT", 8080);
const REFRESH_MS = envInt("REFRESH_MS", 30000);
const MAX_BLOCK_LAG = envInt("MAX_BLOCK_LAG", 50);
const HANDSHAKE_TIMEOUT_MS = envInt("HANDSHAKE_TIMEOUT_MS", 10000);
const NETWORKS = (process.env.NETWORKS || "finney,test")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);

let poolsArtifact = null;
let lastRefresh = 0;
let wasStale = false; // edge-detection state -- see reportPoolStale's own comment
let noUpstreamWindow = null; // owned here, not module-level in observability.mjs -- see computeNoUpstreamWindowUpdate's own comment

function noteNoUpstream(network) {
  const update = computeNoUpstreamWindowUpdate(noUpstreamWindow, network);
  noUpstreamWindow = update.nextWindow;
  if (update.report) reportNoUpstreamWindow(update);
}

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
  const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS * 3;
  if (stale && !wasStale) {
    reportPoolStale(`no successful refresh in over ${REFRESH_MS * 3}ms`);
  }
  wasStale = stale;
}

function poolFor(network) {
  return selectWssUpstreams(poolsArtifact, network, {
    maxBlockLag: MAX_BLOCK_LAG,
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/") {
    const pools = Object.fromEntries(
      NETWORKS.map((n) => [n, poolFor(n).length]),
    );
    const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS * 3;
    // Railway keys health on the HTTP status, so keep the readiness signal in the
    // status code: a stale or uninitialized pool would also reject configured WSS
    // upgrades with 503 because there are no eligible upstreams.
    res.writeHead(stale ? 503 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: !stale,
        stale,
        pools,
        last_refresh_ms: lastRefresh,
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// maxPayload caps inbound client frames at the protocol layer; the app-level
// MAX_RPC_BODY_BYTES check in proxy.mjs only fires AFTER ws buffers the full frame.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_RPC_BODY_BYTES,
});

// Heartbeat: WS over the public internet (behind Cloudflare) accumulates half-open
// sockets that never emit 'close' (NAT/idle timeouts, silent peer death). Each sweep
// terminates any client that hasn't ponged since the last one; proxy.mjs's client
// 'close' handler then tears down that client's upstream socket too.
const HEARTBEAT_MS = envInt("HEARTBEAT_MS", 30000);
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch {
      /* socket already closing */
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

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
    noteNoUpstream(network);
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    client.isAlive = true;
    client.on("pong", () => {
      client.isAlive = true;
    });
    proxy(client, upstreams, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      onNoUpstream: () => noteNoUpstream(network),
    });
  });
});

await refresh();
setInterval(refresh, REFRESH_MS);
server.listen(PORT, () =>
  log(
    `wss-lb listening :${PORT} · networks=${NETWORKS.join(",")} · api=${API}`,
  ),
);
