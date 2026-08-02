// WSS load balancer as a Worker (ADR 0013), replacing the Railway Node service
// in deploy/wss-lb. Same model: refresh the healthy-endpoint pool from the live
// /api/v1/rpc/pools artifact and, at CONNECT time, route each client to the
// freshest/highest-scored upstream, failing over to the next on a failed
// handshake.
//
// WHY A WORKER AT ALL. The Node service exists because Cloudflare's HTTP
// JSON-RPC proxy explicitly punts WebSocket ("WebSocket JSON-RPC is not
// available through this HTTP proxy"). That gap was about the HTTP proxy's own
// request/response shape, not about Workers: a Worker can accept a socket with
// WebSocketPair and dial an upstream with a fetch() carrying `Upgrade:
// websocket`. So the whole service moves, and the Railway dependency goes with
// it.
//
// WHAT IS REUSED UNCHANGED. selectWssUpstreams and its helpers are pure and
// already unit-tested (deploy/wss-lb/test/select.test.ts) -- they are imported
// here rather than reimplemented, so the routing decision this proxy makes is
// the same decision, tested the same way, before and after the move.
//
// WHAT DELIBERATELY CHANGED. The Node service tracked per-IP connection counts
// in process memory, which only worked because it was ONE process. A Worker is
// many isolates across many colos, so an in-memory counter would silently
// enforce nothing. Per-IP abuse control moves to a Rate Limiting binding, which
// is the only thing in this environment that can count across isolates. When
// the binding is absent the proxy still serves -- an abuse control that fails
// CLOSED would turn a misconfiguration into an outage, and this is a
// availability-shaped service.
//
// MID-SESSION UPSTREAM LOSS still closes the client, exactly as before: a
// JSON-RPC subscription cannot be transparently moved to a different node, so
// the honest behaviour is to close and let the client reconnect into a fresh
// selection rather than pretend continuity we cannot provide.
import {
  selectWssUpstreams,
  type PoolsArtifact,
} from "../deploy/wss-lb/src/select.ts";

export interface WssLbEnv {
  // Where the pools artifact is read from. Not hardcoded so a staging
  // deployment can point at a staging API without a code change.
  METAGRAPHED_API?: string;
  // Comma-separated network allowlist (pool ids are `<network>-wss`).
  NETWORKS?: string;
  MAX_BLOCK_LAG?: string;
  HANDSHAKE_TIMEOUT_MS?: string;
  // Optional. Absent => no per-IP limiting (fail open, see header).
  WSS_CONNECT_RATE_LIMITER?: {
    limit(o: { key: string }): Promise<{ success: boolean }>;
  };
}

const DEFAULT_API = "https://api.metagraph.sh";
const DEFAULT_NETWORKS = ["finney", "test"];
const DEFAULT_MAX_BLOCK_LAG = 50;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;
// The pools artifact changes on the health prober's cadence (15 min), so a
// short TTL is plenty and keeps a burst of connects off the origin.
const POOLS_TTL_SECONDS = 60;

function networksOf(env: WssLbEnv): string[] {
  const raw = (env.NETWORKS || "").trim();
  if (!raw) return DEFAULT_NETWORKS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function intOf(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Read the pools artifact through the edge cache. A failure here is NOT fatal
// to an in-flight connect if we have nothing cached -- it just means we cannot
// choose, which the caller turns into a 503 rather than a silent bad route.
export async function loadPools(
  env: WssLbEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<PoolsArtifact | null> {
  const base = env.METAGRAPHED_API || DEFAULT_API;
  try {
    const res = await fetchImpl(`${base}/api/v1/rpc/pools`, {
      cf: { cacheTtl: POOLS_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: PoolsArtifact } & PoolsArtifact;
    // The artifact is served enveloped on /api/v1 and bare as a file; accept
    // both so this keeps working if the route moves.
    return (body.data as PoolsArtifact) ?? (body as PoolsArtifact);
  } catch {
    return null;
  }
}

// Dial one upstream. Returns the accepted socket, or null so the caller can try
// the next candidate -- a failed handshake is expected during an endpoint
// outage and must not abort the whole connect.
export async function dialUpstream(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSocket | null> {
  // wss:// is not a scheme fetch() accepts; the upgrade rides on https.
  const httpsUrl = url.replace(/^wss:\/\//i, "https://");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetchImpl(httpsUrl, {
      headers: { Upgrade: "websocket" },
      signal: abort.signal,
    } as RequestInit);
    const socket = (res as unknown as { webSocket?: WebSocket }).webSocket;
    if (res.status !== 101 || !socket) return null;
    socket.accept();
    return socket;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Bidirectional pipe. Either side closing or erroring tears down the other --
// a half-open socket is worse than a closed one here, because a JSON-RPC client
// waiting on a subscription that can no longer arrive will wait forever.
export function pipe(client: WebSocket, upstream: WebSocket): void {
  let closed = false;
  const teardown = (code?: number, reason?: string) => {
    if (closed) return;
    closed = true;
    try {
      client.close(code, reason);
    } catch {
      /* already gone */
    }
    try {
      upstream.close(code, reason);
    } catch {
      /* already gone */
    }
  };

  client.addEventListener("message", (event) => {
    try {
      upstream.send((event as MessageEvent).data as string | ArrayBuffer);
    } catch {
      teardown(1011, "upstream send failed");
    }
  });
  upstream.addEventListener("message", (event) => {
    try {
      client.send((event as MessageEvent).data as string | ArrayBuffer);
    } catch {
      teardown(1011, "client send failed");
    }
  });
  // 1011 rather than echoing the peer's code: the codes are not
  // interchangeable across a proxy boundary, and inventing a normal-closure on
  // an abnormal one would hide the failure from the client.
  client.addEventListener("close", () => teardown(1000, "client closed"));
  upstream.addEventListener("close", () => teardown(1000, "upstream closed"));
  client.addEventListener("error", () => teardown(1011, "client error"));
  upstream.addEventListener("error", () => teardown(1011, "upstream error"));
}

function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// workerd accepts `new Response(null, { status: 101, webSocket })`; the
// undici Response in a node test runner rejects any status below 200. That is a
// RUNTIME difference, not a behavioural one, so the construction is injectable
// rather than branched on an environment sniff -- the proxy's control flow stays
// identical and testable, and the one workerd-only line is substituted in tests
// instead of being excluded from them.
export function upgradeResponse(
  client: WebSocket,
  upstreamHost: string,
): Response {
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "x-metagraphed-upstream": upstreamHost },
  } as ResponseInit);
}

export async function handleWssLbRequest(
  request: Request,
  env: WssLbEnv,
  deps: {
    fetchImpl?: typeof fetch;
    makeUpgradeResponse?: (client: WebSocket, upstreamHost: string) => Response;
  } = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeUpgradeResponse = deps.makeUpgradeResponse ?? upgradeResponse;
  const url = new URL(request.url);

  if (url.pathname === "/health" || url.pathname === "/") {
    return json(
      { ok: true, service: "wss-lb", networks: networksOf(env) },
      200,
    );
  }

  const network = url.pathname.replace(/^\/+/, "").split("/")[0];
  if (!network || !networksOf(env).includes(network)) {
    return json(
      {
        ok: false,
        error: {
          code: "unknown_network",
          message: `Unknown network. Try one of: ${networksOf(env).join(", ")}.`,
        },
      },
      404,
    );
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json(
      {
        ok: false,
        error: {
          code: "upgrade_required",
          message: "This endpoint serves WebSocket JSON-RPC only.",
        },
      },
      426,
    );
  }

  // Fail OPEN when the binding is absent (see header): an availability service
  // must not be taken down by a missing abuse control.
  if (env.WSS_CONNECT_RATE_LIMITER) {
    const { success } = await env.WSS_CONNECT_RATE_LIMITER.limit({
      key: clientIp(request),
    });
    if (!success) {
      return json(
        {
          ok: false,
          error: {
            code: "connect_rate_limited",
            message: "Too many connection attempts. Retry shortly.",
          },
        },
        429,
      );
    }
  }

  const pools = await loadPools(env, fetchImpl);
  const upstreams = selectWssUpstreams(pools, network, {
    maxBlockLag: intOf(env.MAX_BLOCK_LAG, DEFAULT_MAX_BLOCK_LAG),
  });
  if (!upstreams.length) {
    return json(
      {
        ok: false,
        error: {
          code: "no_healthy_upstream",
          message: `No healthy ${network} WSS endpoint is currently available.`,
        },
      },
      503,
    );
  }

  const timeoutMs = intOf(
    env.HANDSHAKE_TIMEOUT_MS,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  for (const candidate of upstreams) {
    const upstream = await dialUpstream(candidate, timeoutMs, fetchImpl);
    if (!upstream) continue; // expected during an endpoint outage; try the next
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    pipe(server, upstream);
    return makeUpgradeResponse(client, new URL(candidate).host);
  }

  // Every candidate failed its handshake -- the pool believes they are healthy
  // but none would talk to us. That is a different condition from an empty pool
  // and gets its own code so it is diagnosable from the client side.
  return json(
    {
      ok: false,
      error: {
        code: "all_upstreams_unreachable",
        message: `All ${upstreams.length} candidate ${network} upstreams failed to handshake.`,
      },
    },
    502,
  );
}

export default {
  fetch(request: Request, env: WssLbEnv): Promise<Response> {
    return handleWssLbRequest(request, env);
  },
};
