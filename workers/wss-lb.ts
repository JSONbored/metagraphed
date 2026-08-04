// WSS load balancer as a Worker (ADR 0013). It replaced a Railway Node service,
// now deleted -- this is the only implementation. Refreshes the healthy-endpoint
// pool from the live
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
// SELECTION lives in wss-lb-select.ts, pure and unit-tested in
// tests/wss-lb-select.test.ts. It carried over unchanged from the Node service,
// so the routing decision this proxy makes is the same decision, tested the same
// way, before and after the move.
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
//
// WHAT WAS LOST IN THE MOVE AND IS BACK. The Node service refused disallowed RPC
// methods before relaying them. This Worker imported only MAX_RPC_BODY_BYTES from
// that policy and forwarded every method verbatim, so between the Railway retirement
// and this change `author_submitExtrinsic` and `sudo_*` were proxied to five upstream
// providers under our IP reputation on an endpoint documented as read-only. The
// policy is now WSS_DENIED_RPC_PREFIXES in workers/config.ts -- deny-mutations rather
// than the HTTP proxy's 11-method allowlist, because a WebSocket URL is something
// people point a whole Substrate client at and that client cannot start without
// state_call and storage reads. See that constant for the full reasoning.
import { selectWssUpstreams, type PoolsArtifact } from "./wss-lb-select.ts";
import { MAX_RPC_BODY_BYTES, WSS_DENIED_RPC_PREFIXES } from "./config.ts";
import {
  recordExceptionEvent,
  recordUsageEvent,
} from "../src/usage-telemetry.ts";
import { registerModuleStateReset } from "../src/module-state-registry.ts";

export interface WssLbEnv {
  // Where the pools artifact is read from. Not hardcoded so a staging
  // deployment can point at a staging API without a code change.
  METAGRAPHED_API?: string;
  // Comma-separated network allowlist (pool ids are `<network>-wss`).
  NETWORKS?: string;
  MAX_BLOCK_LAG?: string;
  HANDSHAKE_TIMEOUT_MS?: string;
  // PostHog wiring, matching every other Worker (secret + optional host
  // override). Absent => capture is a no-op, the same
  // isUsageTelemetryConfigured contract src/usage-telemetry.ts gives the
  // main Workers.
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string;
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

// ---------------------------------------------------------------------------
// Condition-level PostHog capture (#9046).
//
// Deliberately NOT a blanket catch-capture: every catch block in this file is
// an availability-shaped fallback by design (pool fetch -> null, failed dial
// -> try next, teardown races -> already gone), and capturing those would
// manufacture noise out of routine failovers. What reaches PostHog is the two
// CONDITIONS that mean the proxy is not doing its one job -- a client asked
// for an upstream and none could be produced -- plus any genuinely unhandled
// exception from the fetch handler.
//
// Rate-bounded per isolate: a dead-pool incident makes EVERY connect hit the
// same condition, and the point is "this is happening", not one event per
// attempt -- unbounded capture during an outage is how a free PostHog tier
// gets eaten (#9004). One event per condition per isolate per window; the
// cross-isolate multiplier is bounded by however many isolates Cloudflare is
// running, which for this Worker's traffic is small.
const CONDITION_EVENT_WINDOW_MS = 5 * 60 * 1000;
const conditionLastSentMs = new Map<string, number>();
registerModuleStateReset("workers/wss-lb.ts", () => {
  conditionLastSentMs.clear();
});

/** True at most once per `label` per window per isolate. Exported for tests. */
export function shouldEmitCondition(
  label: string,
  nowMs: number = Date.now(),
): boolean {
  const last = conditionLastSentMs.get(label);
  if (last !== undefined && nowMs - last < CONDITION_EVENT_WINDOW_MS) {
    return false;
  }
  conditionLastSentMs.set(label, nowMs);
  return true;
}

// The `route` labels this Worker emits under. Stable, enumerable, and never
// derived from request data -- they are the query key in PostHog.
const CONDITION_ROUTES = {
  noUpstream: "wss-lb-no-upstream",
  allUnreachable: "wss-lb-all-upstreams-unreachable",
} as const;

// Fire-and-forget capture of one availability condition as a usage_event.
// recordUsageEvent itself never throws and no-ops without a token, so the
// serving path cannot be hurt from here. `waitUntil` keeps the capture alive
// past the response without delaying it; absent (tests, direct calls) the
// promise is simply left to the runtime.
function captureCondition(
  env: WssLbEnv,
  route: string,
  network: string,
  durationMs: number,
  errorCode: string,
  fetchImpl: typeof fetch,
  waitUntil?: (p: Promise<unknown>) => void,
): void {
  if (!shouldEmitCondition(route)) return;
  const pending = recordUsageEvent(
    env as unknown as Env,
    {
      route,
      ok: false,
      durationMs,
      statusClass: "5xx",
      errorCode,
      // `client` carries the network rather than a UA bucket: which pool
      // dried up is the actionable dimension here, and it is a two-value
      // enum.
      client: network,
    },
    // The one fetch this Worker uses everywhere, so tests exercising the
    // condition paths intercept the PostHog POST the same way they already
    // intercept the pools read.
    { fetch: fetchImpl },
  );
  waitUntil?.(pending);
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

// Readiness, not liveness. The Node service keyed its health on the STATUS CODE
// (503 once the pool went stale) precisely because a proxy with no reachable
// upstream is not serving, and this is the one signal an external monitor gets:
// answering a flat 200 would report the exact outage this service exists to
// route around as healthy. So the same question the connect path asks -- can
// selection actually produce an upstream? -- is asked here.
//
// `last_refresh_ms` from the Node service's body is deliberately NOT carried
// over rather than filled with a placeholder: that number reported a background
// refresh loop this Worker does not have (pools are read per-request through the
// edge cache), so any value here would be invented. Omitted, per the same rule
// applied to the embedding token count in #8979.
export async function healthResponse(
  env: WssLbEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const networks = networksOf(env);
  const pools = await loadPools(env, fetchImpl);
  // No artifact at all is the same condition the connect path turns into a 503,
  // and it is distinct from a fetched-but-empty pool -- reported separately so a
  // monitor can tell "the registry is unreachable" from "every endpoint is down".
  const stale = pools === null;
  const maxBlockLag = intOf(env.MAX_BLOCK_LAG, DEFAULT_MAX_BLOCK_LAG);
  const counts: Record<string, number> = {};
  for (const network of networks) {
    counts[network] = selectWssUpstreams(pools, network, {
      maxBlockLag,
    }).length;
  }
  // "Every network is empty", not "any" -- one network degraded while the other
  // serves is a real, partially-working state, and 503-ing the whole proxy for it
  // would take down the healthy network's traffic on a monitor's say-so.
  const ok = !stale && !networks.every((network) => counts[network] === 0);
  return json(
    { ok, stale, service: "wss-lb", networks, pools: counts },
    ok ? 200 : 503,
  );
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

// The Node service capped inbound client frames at the protocol layer
// (`new WebSocketServer({ maxPayload: MAX_RPC_BODY_BYTES })`), which a Worker
// has no equivalent knob for -- so the cap is applied here instead, or it is
// simply gone and one client can push arbitrarily large frames through us at an
// upstream's expense.
//
// Wire BYTES, like maxPayload counted, not String.length: a multi-byte UTF-8
// body would otherwise slip past a character count at up to 4x the cap. The
// encode is skipped in both directions where the answer is already decided by
// length alone, so the common small-JSON-RPC frame never pays for it.
export function exceedsFrameCap(data: string | ArrayBuffer): boolean {
  if (typeof data !== "string") return data.byteLength > MAX_RPC_BODY_BYTES;
  if (data.length > MAX_RPC_BODY_BYTES) return true;
  if (data.length * 4 <= MAX_RPC_BODY_BYTES) return false;
  return new TextEncoder().encode(data).byteLength > MAX_RPC_BODY_BYTES;
}

// Is this client frame a call we refuse to relay?
//
// Returns the offending method name, or null to forward. Parsing is deliberately
// forgiving in one direction only: a frame we cannot parse as a JSON-RPC object with
// a string `method` is FORWARDED, because the upstream is the authority on its own
// wire format and rejecting what we merely failed to understand would break clients
// over our parser rather than over policy. A frame we CAN parse and that names a
// denied method is refused — that is the whole check.
//
// Batches (a JSON array) are refused outright rather than inspected element by
// element. The HTTP proxy already refuses batches, an array containing one denied
// call would otherwise need per-element error mapping, and no Substrate client sends
// them over a subscription socket.
export function deniedRpcMethod(data: string | ArrayBuffer): string | null {
  if (typeof data !== "string") return null;
  let rpc: unknown;
  try {
    rpc = JSON.parse(data);
  } catch {
    return null;
  }
  if (Array.isArray(rpc)) return "batch";
  if (!rpc || typeof rpc !== "object") return null;
  const method = (rpc as { method?: unknown }).method;
  if (typeof method !== "string") return null;
  return WSS_DENIED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))
    ? method
    : null;
}

function rpcMethodNotAllowed(data: string, method: string): string {
  let id: string | number | null = null;
  try {
    const parsed = JSON.parse(data) as { id?: unknown };
    if (
      typeof parsed.id === "string" ||
      typeof parsed.id === "number" ||
      parsed.id === null
    ) {
      id = parsed.id;
    }
  } catch {
    /* already parsed once above; keep the null id rather than throw here */
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `RPC method is not allowed through this read-only proxy: ${method}`,
    },
  });
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
    const data = (event as MessageEvent).data as string | ArrayBuffer;
    // 1009 (message too big) rather than dropping the frame silently: a client
    // whose request never reaches an upstream would otherwise wait forever on a
    // response that is never coming. Same close-the-connection behaviour
    // `maxPayload` had.
    if (exceedsFrameCap(data)) {
      teardown(1009, "frame exceeds max size");
      return;
    }
    // A denied method is answered, not disconnected. Tearing the socket down would
    // take every in-flight subscription on it with them, and a client that asked one
    // question we refuse has not necessarily asked anything else wrong -- the HTTP
    // proxy answers -32601 for the same reason.
    const denied = deniedRpcMethod(data);
    if (denied) {
      try {
        client.send(rpcMethodNotAllowed(data as string, denied));
      } catch {
        teardown(1011, "client send failed");
      }
      return;
    }
    try {
      upstream.send(data);
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
    waitUntil?: (p: Promise<unknown>) => void;
  } = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const makeUpgradeResponse = deps.makeUpgradeResponse ?? upgradeResponse;
  const startedMs = Date.now();
  const url = new URL(request.url);

  // /healthz is the DEPLOYED contract -- it is what railway.json's
  // healthcheckPath points at and what the live service has answered on
  // wss.metagraph.sh since it shipped, so anything already watching this service
  // is watching that path. Renaming it to /health as part of the port would have
  // silently 404'd every existing monitor the moment the route moved. /health is
  // kept as the name the rest of this codebase uses.
  if (
    url.pathname === "/healthz" ||
    url.pathname === "/health" ||
    url.pathname === "/"
  ) {
    return healthResponse(env, fetchImpl);
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
    // The condition the config comment names as the reason full-sampled logs
    // are on: a proxy that stops finding upstreams. `pools === null` (artifact
    // unfetchable) and an empty selection (artifact fine, every endpoint
    // filtered out) share the client-facing 503 but are distinct faults --
    // the error_code dimension keeps them distinguishable in PostHog.
    captureCondition(
      env,
      CONDITION_ROUTES.noUpstream,
      network,
      Date.now() - startedMs,
      pools === null ? "pool_unfetchable" : "no_healthy_upstream",
      fetchImpl,
      deps.waitUntil,
    );
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
  captureCondition(
    env,
    CONDITION_ROUTES.allUnreachable,
    network,
    Date.now() - startedMs,
    "all_upstreams_unreachable",
    fetchImpl,
    deps.waitUntil,
  );
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
  async fetch(
    request: Request,
    env: WssLbEnv,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const waitUntil = ctx ? ctx.waitUntil.bind(ctx) : undefined;
    try {
      return await handleWssLbRequest(request, env, { waitUntil });
    } catch (error) {
      // A genuinely UNHANDLED throw -- every expected failure above already
      // degrades to a typed JSON error. This is the third condition #9046
      // names, and the only $exception this Worker emits. Same per-isolate
      // bound as the availability conditions: a crash loop is one event per
      // window, not one per request.
      if (shouldEmitCondition("wss-lb-unhandled-exception")) {
        // Two statements, not `waitUntil?.(record...())`: an optional call
        // short-circuits its ARGUMENT too, so the one-liner would silently
        // skip the capture whenever ctx is absent.
        const pending = recordExceptionEvent(env as unknown as Env, {
          error,
          route: "wss-lb-unhandled-exception",
        });
        waitUntil?.(pending);
      }
      return json(
        {
          ok: false,
          error: {
            code: "internal_error",
            message: "Unexpected proxy error.",
          },
        },
        500,
      );
    }
  },
};
