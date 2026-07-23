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
// Cloudflare DNS for TLS/DDoS, with per-IP abuse control (rate-limit.ts).
// Env: METAGRAPHED_API, PORT, REFRESH_MS, MAX_BLOCK_LAG, NETWORKS,
// HANDSHAKE_TIMEOUT_MS, MAX_CONNECTIONS_PER_IP, CONNECT_RATE_LIMIT,
// CONNECT_RATE_WINDOW_MS. Optionally SENTRY_DSN/SENTRY_ENVIRONMENT/
// SENTRY_RELEASE (silently no-ops if SENTRY_DSN is unset -- see
// src/observability.ts).
import http from "node:http";

import { WebSocketServer } from "ws";

import { MAX_RPC_BODY_BYTES } from "./rpc-policy.ts";
import { proxy } from "./proxy.ts";
import { createConnectionLimiter, resolveClientIp } from "./rate-limit.ts";
import { selectWssUpstreams, type PoolsArtifact } from "./select.ts";
import {
  initSentry,
  endSessionAndFlush,
  computeNoUpstreamWindowUpdate,
  reportNoUpstreamWindow,
  reportPoolStale,
  type NoUpstreamWindow,
} from "./observability.ts";

// `ws`'s WebSocket doesn't declare this -- server.ts stamps a liveness flag on
// each client for the heartbeat sweep below (module augmentation instead of a
// cast at every read/write site).
declare module "ws" {
  interface WebSocket {
    isAlive?: boolean;
  }
}

initSentry();

// Numeric env with a NaN/positivity guard: Number(process.env.X || d) returns NaN
// for a non-numeric string (the `|| d` only catches empty/unset), which would
// poison the refresh timer, the /healthz staleness gate, and the block-lag filter.
const envInt = (key: string, fallback: number): number => {
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
// #6444: per-IP abuse control, see rate-limit.ts for the reasoning behind
// both budgets and their defaults.
const MAX_CONNECTIONS_PER_IP = envInt("MAX_CONNECTIONS_PER_IP", 20);
const CONNECT_RATE_LIMIT = envInt("CONNECT_RATE_LIMIT", 30);
const CONNECT_RATE_WINDOW_MS = envInt("CONNECT_RATE_WINDOW_MS", 60000);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let poolsArtifact: PoolsArtifact | null = null;
let lastRefresh = 0;
let wasStale = false; // edge-detection state -- see reportPoolStale's own comment
let noUpstreamWindow: NoUpstreamWindow | null = null; // owned here, not module-level in observability.ts -- see computeNoUpstreamWindowUpdate's own comment

function noteNoUpstream(network: string) {
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
    const body = (await res.json()) as {
      pools?: unknown;
      data?: { pools?: unknown };
    };
    const artifact: PoolsArtifact | null = Array.isArray(body?.pools)
      ? (body as PoolsArtifact)
      : Array.isArray(body?.data?.pools)
        ? (body.data as PoolsArtifact)
        : null;
    if (artifact) {
      poolsArtifact = artifact;
      lastRefresh = Date.now();
    }
  } catch (e) {
    log("refresh failed:", String((e as Error)?.message || e).slice(0, 160));
  }
  const stale = !lastRefresh || Date.now() - lastRefresh > REFRESH_MS * 3;
  if (stale && !wasStale) {
    reportPoolStale(`no successful refresh in over ${REFRESH_MS * 3}ms`);
  }
  wasStale = stale;
}

function poolFor(network: string) {
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
// MAX_RPC_BODY_BYTES check in proxy.ts only fires AFTER ws buffers the full frame.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_RPC_BODY_BYTES,
});

// Heartbeat: WS over the public internet (behind Cloudflare) accumulates half-open
// sockets that never emit 'close' (NAT/idle timeouts, silent peer death). Each sweep
// terminates any client that hasn't ponged since the last one; proxy.ts's client
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

const connectionLimiter = createConnectionLimiter({
  maxConcurrent: MAX_CONNECTIONS_PER_IP,
  maxAttemptsPerWindow: CONNECT_RATE_LIMIT,
  windowMs: CONNECT_RATE_WINDOW_MS,
});
const rateLimitPrune = setInterval(
  () => connectionLimiter.prune(),
  CONNECT_RATE_WINDOW_MS,
);
rateLimitPrune.unref?.();

server.on("upgrade", (req, socket, head) => {
  // Cheapest possible rejection point: before any network-name/pool lookup,
  // let alone an upstream dial.
  const clientIp = resolveClientIp(req);
  const limit = connectionLimiter.checkAndTrack(clientIp);
  if (!limit.ok) {
    log(`rate-limited: ${clientIp} (${limit.reason})`);
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${limit.retryAfterSeconds}\r\n\r\n`,
    );
    socket.destroy();
    return;
  }
  const network = (req.url || "/")
    .replace(/^\/+/, "")
    .split("?")[0]
    .split("/")[0];
  if (!NETWORKS.includes(network)) {
    connectionLimiter.release(clientIp);
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstreams = poolFor(network);
  if (!upstreams.length) {
    connectionLimiter.release(clientIp);
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    noteNoUpstream(network);
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    client.isAlive = true;
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      connectionLimiter.release(clientIp);
    };
    client.on("pong", () => {
      client.isAlive = true;
    });
    client.on("close", releaseOnce);
    client.on("error", releaseOnce);
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

// Railway sends SIGTERM on every redeploy -- without this, the process
// simply dies mid-"ok" and its Sentry release-health session is never
// closed, reporting neither healthy nor crashed. Scoped to just the Sentry
// session (not draining in-flight WS connections/the HTTP server): the
// process manager already restarts on exit, and existing client sockets
// close on their own once the process actually exits either way.
async function shutdown() {
  await endSessionAndFlush();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
