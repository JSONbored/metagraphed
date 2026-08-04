// Unit tests for the WSS load balancer Worker (workers/wss-lb.ts), which
// replaced the Railway Node service, deleted in #9353.
//
// The routing DECISION (selectWssUpstreams) is already covered by
// tests/wss-lb-select.test.ts and is imported unchanged, so it is not
// re-tested here. What is new -- and what these cover -- is the Worker-shaped
// boundary around it: which HTTP status each failure mode produces, and that a
// failed handshake falls through to the next candidate rather than aborting the
// connect.
//
// WebSocketPair is a workerd global with no node equivalent, so the 101 path
// installs a minimal stub. The stub is deliberately dumb: these tests assert
// the proxy's CONTROL FLOW, not that a real socket carries bytes, which only a
// live handshake can demonstrate.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  deniedRpcMethod,
  dialUpstream,
  exceedsFrameCap,
  handleWssLbRequest,
  healthResponse,
  loadPools,
  pipe,
  type WssLbEnv,
} from "../workers/wss-lb.ts";
import {
  DENIED_RPC_PREFIXES,
  MAX_RPC_BODY_BYTES,
  WSS_DENIED_RPC_PREFIXES,
} from "../workers/config.ts";

const POOLS = {
  pools: [
    {
      id: "finney-wss",
      kind: "subtensor-wss",
      endpoints: [
        {
          url: "wss://good.example",
          pool_eligible: true,
          score: 90,
          latest_block: 100,
        },
        {
          url: "wss://second.example",
          pool_eligible: true,
          score: 50,
          latest_block: 100,
        },
      ],
    },
  ],
};

function poolsFetch(body: unknown = POOLS, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function wsRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://wss.metagraph.sh${path}`, {
    headers: { upgrade: "websocket", ...headers },
  });
}

class FakeSocket {
  accepted = false;
  closed = false;
  accept() {
    this.accepted = true;
  }
  close() {
    this.closed = true;
  }
  send() {}
  addEventListener() {}
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).WebSocketPair = function () {
    return [new FakeSocket(), new FakeSocket()];
  };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>).WebSocketPair;
});

// /healthz is the path the live Railway service actually served and the one
// railway.json's healthcheckPath points at, so it is the contract an existing
// monitor is pointed at -- all three aliases are pinned so a future tidy-up
// cannot quietly drop it again.
for (const path of ["/healthz", "/health", "/"]) {
  test(`${path} reports the configured networks and their pool depth`, async () => {
    const res = await handleWssLbRequest(
      new Request(`https://wss.metagraph.sh${path}`),
      {} as WssLbEnv,
      { fetchImpl: poolsFetch() },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      stale: boolean;
      networks: string[];
      pools: Record<string, number>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.stale, false);
    assert.deepEqual(body.networks, ["finney", "test"]);
    // finney has the two POOLS endpoints; test has none. A partially-serving
    // proxy is still serving -- see healthResponse's "every, not any" comment.
    assert.deepEqual(body.pools, { finney: 2, test: 0 });
  });
}

// The whole point of restoring the status-code signal: an unreachable registry
// means selection cannot produce an upstream for ANY network, and a monitor must
// be able to see that. A flat 200 here would report the outage as healthy.
test("health is 503 when the pools artifact is unreachable", async () => {
  const res = await healthResponse({} as WssLbEnv, poolsFetch(null, false));
  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; stale: boolean };
  assert.equal(body.ok, false);
  assert.equal(body.stale, true);
});

// Distinct from the unreachable case above: the registry answered, it just has
// nothing eligible. `stale` separates the two so a monitor can tell them apart.
test("health is 503, but not stale, when every network's pool is empty", async () => {
  const res = await healthResponse({} as WssLbEnv, poolsFetch({ pools: [] }));
  assert.equal(res.status, 503);
  const body = (await res.json()) as {
    ok: boolean;
    stale: boolean;
    pools: Record<string, number>;
  };
  assert.equal(body.ok, false);
  assert.equal(body.stale, false);
  assert.deepEqual(body.pools, { finney: 0, test: 0 });
});

// A body field that reported a background refresh loop this Worker does not
// have would be invented. Pinned so it is not "helpfully" added back as a 0.
test("health omits last_refresh_ms rather than inventing one", async () => {
  const res = await healthResponse({} as WssLbEnv, poolsFetch());
  assert.equal("last_refresh_ms" in ((await res.json()) as object), false);
});

test("an unknown network is 404, not a failed dial", async () => {
  const res = await handleWssLbRequest(wsRequest("/nope"), {} as WssLbEnv);
  assert.equal(res.status, 404);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "unknown_network",
  );
});

test("a plain GET without an Upgrade header is 426", async () => {
  const res = await handleWssLbRequest(
    new Request("https://wss.metagraph.sh/finney"),
    {} as WssLbEnv,
  );
  assert.equal(res.status, 426);
});

test("an empty pool is 503 rather than a hang", async () => {
  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: poolsFetch({ pools: [] }),
  });
  assert.equal(res.status, 503);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "no_healthy_upstream",
  );
});

// An unreachable pools artifact must not be mistaken for "the pool is empty" by
// accident -- both are 503 here, but only because selection legitimately cannot
// proceed. Asserted so a future change that starts serving a stale/default pool
// on fetch failure has to do so deliberately.
test("an unreachable pools artifact degrades to 503", async () => {
  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: poolsFetch(null, false),
  });
  assert.equal(res.status, 503);
});

test("rate-limited connects are rejected with 429", async () => {
  const env = {
    WSS_CONNECT_RATE_LIMITER: { limit: async () => ({ success: false }) },
  } as unknown as WssLbEnv;
  const res = await handleWssLbRequest(wsRequest("/finney"), env, {
    fetchImpl: poolsFetch(),
  });
  assert.equal(res.status, 429);
});

// Fail-open is a deliberate availability choice, not an oversight: an abuse
// control that fails closed turns a missing binding into an outage.
test("a missing rate-limiter binding does not block the connect", async () => {
  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: poolsFetch(),
  });
  assert.notEqual(res.status, 429);
});

test("every candidate failing its handshake is 502, distinct from an empty pool", async () => {
  // 500 on the upgrade attempt => never 101 => dialUpstream returns null.
  const failing = (async (input: string | Request) => {
    const href = typeof input === "string" ? input : input.url;
    if (href.includes("/api/v1/rpc/pools")) {
      return { ok: true, status: 200, json: async () => POOLS } as Response;
    }
    return { ok: false, status: 500 } as Response;
  }) as unknown as typeof fetch;

  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: failing,
  });
  assert.equal(res.status, 502);
  assert.equal(
    ((await res.json()) as { error: { code: string } }).error.code,
    "all_upstreams_unreachable",
  );
});

test("the first upstream that handshakes is used, and the client gets a 101", async () => {
  let dialled = 0;
  const okFetch = (async (input: string | Request) => {
    const href = typeof input === "string" ? input : input.url;
    if (href.includes("/api/v1/rpc/pools")) {
      return { ok: true, status: 200, json: async () => POOLS } as Response;
    }
    dialled += 1;
    return {
      ok: true,
      status: 101,
      webSocket: new FakeSocket(),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  // Node's Response rejects status 101 (workerd does not), so the workerd-only
  // construction is substituted -- the assertion is about which upstream the
  // proxy CHOSE, which is the part that can be wrong.
  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: okFetch,
    makeUpgradeResponse: (_client, host) =>
      new Response(null, {
        status: 200,
        headers: { "x-metagraphed-upstream": host },
      }),
  });
  assert.equal(res.status, 200);
  // Only the best-scored candidate is dialled -- failover must not fan out.
  assert.equal(dialled, 1);
  assert.equal(res.headers.get("x-metagraphed-upstream"), "good.example");
});

test("dialUpstream rewrites wss:// to https:// for the upgrade fetch", async () => {
  let seen = "";
  const capture = (async (input: string | Request) => {
    seen = typeof input === "string" ? input : input.url;
    return {
      ok: true,
      status: 101,
      webSocket: new FakeSocket(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  await dialUpstream("wss://node.example/path", 1000, capture);
  assert.equal(seen, "https://node.example/path");
});

// The Node service got this cap from `new WebSocketServer({ maxPayload })`,
// which counted WIRE BYTES. A character count would let a multi-byte body
// through at up to 4x the cap, so each of the four decision paths is pinned.
test("exceedsFrameCap measures binary frames by byte length", () => {
  assert.equal(exceedsFrameCap(new ArrayBuffer(MAX_RPC_BODY_BYTES)), false);
  assert.equal(exceedsFrameCap(new ArrayBuffer(MAX_RPC_BODY_BYTES + 1)), true);
});

test("exceedsFrameCap rejects a string longer than the cap without encoding", () => {
  assert.equal(exceedsFrameCap("a".repeat(MAX_RPC_BODY_BYTES + 1)), true);
});

test("exceedsFrameCap admits a short frame without encoding", () => {
  assert.equal(exceedsFrameCap('{"jsonrpc":"2.0"}'), false);
});

// The case a character count gets wrong: under the cap in characters, over it in
// UTF-8 bytes. This is the path that actually needs the encode.
test("exceedsFrameCap counts multi-byte characters as their byte length", () => {
  // 3 bytes each in UTF-8, so comfortably over the cap while well under it in
  // characters -- String.length would wave this through.
  const wide = "一".repeat(MAX_RPC_BODY_BYTES / 2);
  assert.ok(wide.length < MAX_RPC_BODY_BYTES);
  assert.equal(exceedsFrameCap(wide), true);
  // Same encode path, but genuinely under the cap once measured in bytes. The
  // length has to land in the window where neither shortcut can decide it:
  // above MAX/4 (so 4-bytes-per-char cannot rule it out) and at or below MAX/3
  // (so 3-bytes-per-char keeps it under). 20,000 sits inside that window.
  const narrow = "一".repeat(20_000);
  assert.ok(narrow.length <= MAX_RPC_BODY_BYTES);
  assert.ok(narrow.length * 4 > MAX_RPC_BODY_BYTES);
  assert.equal(exceedsFrameCap(narrow), false);
});

// A recording socket -- FakeSocket's addEventListener is a no-op, so it cannot
// drive pipe()'s handlers.
class PipeSocket {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  sent: (string | ArrayBuffer)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  addEventListener(type: string, fn: (event: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  emit(type: string, event: unknown) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
}

test("pipe forwards a client frame under the cap", () => {
  const client = new PipeSocket();
  const upstream = new PipeSocket();
  pipe(client as unknown as WebSocket, upstream as unknown as WebSocket);
  client.emit("message", { data: '{"id":1}' });
  assert.deepEqual(upstream.sent, ['{"id":1}']);
  assert.equal(client.closedWith, null);
});

// 1009 (message too big), and the frame must NOT reach the upstream -- the
// whole point of the cap is that we absorb the abuse instead of relaying it.
test("pipe closes with 1009 on an oversized client frame", () => {
  const client = new PipeSocket();
  const upstream = new PipeSocket();
  pipe(client as unknown as WebSocket, upstream as unknown as WebSocket);
  client.emit("message", { data: "a".repeat(MAX_RPC_BODY_BYTES + 1) });
  assert.deepEqual(upstream.sent, []);
  assert.equal(client.closedWith?.code, 1009);
  assert.equal(upstream.closedWith?.code, 1009);
});

// ---------------------------------------------------------------------------
// The read-only policy (#9353). It was enforced by the Railway service, dropped
// silently in the Worker migration, and is back. Every test below fails against
// the version that forwarded everything.
// ---------------------------------------------------------------------------

test("a submission is refused rather than proxied to an upstream", () => {
  const client = new PipeSocket();
  const upstream = new PipeSocket();
  pipe(client as unknown as WebSocket, upstream as unknown as WebSocket);
  client.emit("message", {
    data: '{"jsonrpc":"2.0","id":7,"method":"author_submitExtrinsic","params":["0x00"]}',
  });
  assert.deepEqual(upstream.sent, []);
  const reply = JSON.parse(client.sent[0] as string);
  assert.equal(reply.error.code, -32601);
  assert.equal(
    reply.id,
    7,
    "the caller's id must come back or its promise hangs",
  );
});

// A refused method must not take the socket down: an open subscription on the same
// connection is unrelated to the one call we declined.
test("a refused method leaves the connection open", () => {
  const client = new PipeSocket();
  const upstream = new PipeSocket();
  pipe(client as unknown as WebSocket, upstream as unknown as WebSocket);
  client.emit("message", { data: '{"id":1,"method":"sudo_sudo"}' });
  assert.equal(client.closedWith, null);
  assert.equal(upstream.closedWith, null);
  client.emit("message", { data: '{"id":2,"method":"chain_getHeader"}' });
  assert.deepEqual(upstream.sent, ['{"id":2,"method":"chain_getHeader"}']);
});

for (const method of [
  "author_submitExtrinsic",
  "author_submitAndWatchExtrinsic",
  "sudo_sudo",
  "payment_queryInfo",
  "contracts_call",
]) {
  test(`${method} is denied`, () => {
    assert.equal(deniedRpcMethod(`{"id":1,"method":"${method}"}`), method);
  });
}

// The deliberate widening: a WebSocket URL is something people point a whole
// Substrate client at, and no such client can start without these. Denying them
// would not narrow the endpoint, it would end it.
for (const method of [
  "state_call",
  "state_getStorage",
  "state_getMetadata",
  "state_getKeysPaged",
  "chain_subscribeNewHeads",
  "system_health",
]) {
  test(`${method} is allowed through the WSS proxy`, () => {
    assert.equal(deniedRpcMethod(`{"id":1,"method":"${method}"}`), null);
  });
}

test("a batch is refused rather than inspected element by element", () => {
  assert.equal(
    deniedRpcMethod('[{"id":1,"method":"chain_getHeader"}]'),
    "batch",
  );
});

// Forgiving in one direction only: what we cannot parse is the upstream's business,
// and rejecting it would break clients over our parser rather than over policy.
for (const frame of [
  '{"id":1}',
  "not json at all",
  '{"method":42}',
  '"a string"',
]) {
  test(`an unparseable or method-less frame is forwarded: ${frame}`, () => {
    assert.equal(deniedRpcMethod(frame), null);
  });
}

// This used to assert `deniedRpcMethod(new ArrayBuffer(8)) === null` under the
// name "a binary frame is not policy-checked as text" -- encoding the bypass as
// intended behaviour. jsonrpsee parses Data::Binary exactly like Data::Text, so
// framing the same JSON as binary is a full escape from the policy, not a
// different protocol.
test("a denied method is refused when framed as BINARY, not just text", () => {
  for (const prefix of WSS_DENIED_RPC_PREFIXES) {
    const frame = new TextEncoder().encode(
      `{"jsonrpc":"2.0","id":1,"method":"${prefix}anything","params":[]}`,
    ).buffer as ArrayBuffer;
    assert.equal(
      deniedRpcMethod(frame),
      `${prefix}anything`,
      `${prefix} is enforced for text frames but bypassed by a binary frame`,
    );
  }
});

test("an allowed method framed as binary is still forwarded", () => {
  const frame = new TextEncoder().encode(
    '{"jsonrpc":"2.0","id":1,"method":"chain_getHeader"}',
  ).buffer as ArrayBuffer;
  assert.equal(deniedRpcMethod(frame), null);
});

test("a binary batch is refused the same way a text batch is", () => {
  const frame = new TextEncoder().encode(
    '[{"id":1,"method":"chain_getHeader"}]',
  ).buffer as ArrayBuffer;
  assert.equal(deniedRpcMethod(frame), "batch");
});

test("binary bytes that are not valid UTF-8 are forwarded, never guessed at", () => {
  assert.equal(
    deniedRpcMethod(new Uint8Array([0xff, 0xfe, 0xff]).buffer),
    null,
  );
});

test("binary bytes that decode but are not JSON are forwarded", () => {
  assert.equal(deniedRpcMethod(new ArrayBuffer(8)), null);
});

// The gap that let this ship: the sync test asserts the two policy COPIES match,
// and nothing asserted either was applied. This is the missing half.
test("the worker enforces the policy it declares", () => {
  for (const prefix of WSS_DENIED_RPC_PREFIXES) {
    assert.equal(
      deniedRpcMethod(`{"id":1,"method":"${prefix}anything"}`),
      `${prefix}anything`,
      `${prefix} is declared denied but is not enforced`,
    );
  }
});

// Mutating prefixes must never be droppable from the WSS list by a later edit that
// only meant to widen the read surface.
test("every mutating prefix the HTTP proxy denies is also denied on WSS", () => {
  for (const prefix of DENIED_RPC_PREFIXES) {
    if (prefix === "state_call") continue; // deliberately allowed, see config.ts
    assert.ok(
      WSS_DENIED_RPC_PREFIXES.includes(prefix),
      `${prefix} is denied on HTTP but not on WSS`,
    );
  }
});

// The upstream direction is deliberately uncapped (responses come from our own
// health-checked pool, not from the client), but it must still relay.
test("pipe relays upstream frames back to the client", () => {
  const client = new PipeSocket();
  const upstream = new PipeSocket();
  pipe(client as unknown as WebSocket, upstream as unknown as WebSocket);
  upstream.emit("message", { data: '{"result":1}' });
  assert.deepEqual(client.sent, ['{"result":1}']);
});

test("loadPools accepts both the enveloped and bare artifact shapes", async () => {
  const enveloped = await loadPools(
    {} as WssLbEnv,
    poolsFetch({ data: POOLS }),
  );
  assert.equal(enveloped?.pools?.length, 1);
  const bare = await loadPools({} as WssLbEnv, poolsFetch(POOLS));
  assert.equal(bare?.pools?.length, 1);
});

// ---------------------------------------------------------------------------
// Condition-level PostHog capture (#9046). What is pinned here, deliberately:
// the two availability conditions and the unhandled-throw path emit; routine
// failover and healthy serving do NOT; and the per-isolate window means an
// outage is one event per condition, not one per connect attempt.

import { shouldEmitCondition } from "../workers/wss-lb.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import {
  POSTHOG_CAPTURE_PATH,
  USAGE_EVENT_NAME,
} from "../src/usage-telemetry.ts";

const TELEMETRY_ENV = { POSTHOG_PROJECT_TOKEN: "phc_test" } as WssLbEnv;

// One fetch serving both roles, exactly as in the Worker: pools reads AND the
// PostHog capture POST. Captured events accumulate in `captured`.
function poolsAndPosthogFetch(
  captured: Array<Record<string, unknown>>,
  poolsBody: unknown = POOLS,
  upstreamStatus = 500,
): typeof fetch {
  return (async (input: string | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input.url;
    if (href.includes(POSTHOG_CAPTURE_PATH)) {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200 } as Response;
    }
    if (href.includes("/api/v1/rpc/pools")) {
      return { ok: true, status: 200, json: async () => poolsBody } as Response;
    }
    return { ok: false, status: upstreamStatus } as Response;
  }) as unknown as typeof fetch;
}

test("shouldEmitCondition allows one event per label per window", () => {
  resetModuleState();
  assert.equal(shouldEmitCondition("wss-test-label", 1_000), true);
  assert.equal(shouldEmitCondition("wss-test-label", 2_000), false);
  // A DIFFERENT label has its own window.
  assert.equal(shouldEmitCondition("wss-other-label", 2_000), true);
  // The same label emits again once the window has fully elapsed.
  assert.equal(
    shouldEmitCondition("wss-test-label", 1_000 + 5 * 60 * 1000),
    true,
  );
});

test("an empty pool emits ONE wss-lb-no-upstream usage event, window-bounded", async () => {
  resetModuleState();
  const captured: Array<Record<string, unknown>> = [];
  const deps = { fetchImpl: poolsAndPosthogFetch(captured, { pools: [] }) };
  const waits: Promise<unknown>[] = [];
  const res = await handleWssLbRequest(wsRequest("/finney"), TELEMETRY_ENV, {
    ...deps,
    waitUntil: (p) => waits.push(p),
  });
  assert.equal(res.status, 503);
  await Promise.all(waits);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, USAGE_EVENT_NAME);
  const props = captured[0].properties as Record<string, unknown>;
  assert.equal(props.route, "wss-lb-no-upstream");
  assert.equal(props.ok, false);
  assert.equal(props.status_class, "5xx");
  assert.equal(props.error_code, "no_healthy_upstream");
  assert.equal(props.client, "finney");

  // A second connect during the same window hits the same condition but emits
  // NOTHING -- the whole point of the per-isolate bound (#9004).
  const res2 = await handleWssLbRequest(wsRequest("/finney"), TELEMETRY_ENV, {
    ...deps,
    waitUntil: (p) => waits.push(p),
  });
  assert.equal(res2.status, 503);
  await Promise.all(waits);
  assert.equal(captured.length, 1);
});

test("an unfetchable pools artifact is the same route but error_code pool_unfetchable", async () => {
  resetModuleState();
  const captured: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: string | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input.url;
    if (href.includes(POSTHOG_CAPTURE_PATH)) {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200 } as Response;
    }
    return { ok: false, status: 500 } as Response; // pools read fails
  }) as unknown as typeof fetch;
  const waits: Promise<unknown>[] = [];
  const res = await handleWssLbRequest(wsRequest("/finney"), TELEMETRY_ENV, {
    fetchImpl,
    waitUntil: (p) => waits.push(p),
  });
  assert.equal(res.status, 503);
  await Promise.all(waits);
  assert.equal(captured.length, 1);
  const props = captured[0].properties as Record<string, unknown>;
  assert.equal(props.route, "wss-lb-no-upstream");
  assert.equal(props.error_code, "pool_unfetchable");
});

test("every candidate failing its handshake emits wss-lb-all-upstreams-unreachable", async () => {
  resetModuleState();
  const captured: Array<Record<string, unknown>> = [];
  const waits: Promise<unknown>[] = [];
  const res = await handleWssLbRequest(wsRequest("/finney"), TELEMETRY_ENV, {
    fetchImpl: poolsAndPosthogFetch(captured),
    waitUntil: (p) => waits.push(p),
  });
  assert.equal(res.status, 502);
  await Promise.all(waits);
  assert.equal(captured.length, 1);
  const props = captured[0].properties as Record<string, unknown>;
  assert.equal(props.route, "wss-lb-all-upstreams-unreachable");
  assert.equal(props.error_code, "all_upstreams_unreachable");
});

test("a successful connect and routine failover emit NOTHING", async () => {
  resetModuleState();
  const captured: Array<Record<string, unknown>> = [];
  // First candidate fails its handshake (routine failover), second succeeds.
  let dialled = 0;
  const fetchImpl = (async (input: string | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input.url;
    if (href.includes(POSTHOG_CAPTURE_PATH)) {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200 } as Response;
    }
    if (href.includes("/api/v1/rpc/pools")) {
      return { ok: true, status: 200, json: async () => POOLS } as Response;
    }
    dialled += 1;
    if (dialled === 1) return { ok: false, status: 500 } as Response;
    return {
      ok: true,
      status: 101,
      webSocket: new FakeSocket(),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  const res = await handleWssLbRequest(wsRequest("/finney"), TELEMETRY_ENV, {
    fetchImpl,
    makeUpgradeResponse: () => new Response(null, { status: 200 }),
  });
  assert.equal(res.status, 200);
  assert.equal(dialled, 2); // the failover really happened
  assert.equal(captured.length, 0); // and produced no event
});

test("an unconfigured deployment serves the 503 identically and posts nothing", async () => {
  resetModuleState();
  const captured: Array<Record<string, unknown>> = [];
  const res = await handleWssLbRequest(wsRequest("/finney"), {} as WssLbEnv, {
    fetchImpl: poolsAndPosthogFetch(captured, { pools: [] }),
  });
  assert.equal(res.status, 503);
  assert.equal(captured.length, 0);
});

test("an unhandled throw from the handler is a 500 with ONE $exception", async () => {
  resetModuleState();
  const wssLb = (await import("../workers/wss-lb.ts")).default;
  const captured: Array<Record<string, unknown>> = [];
  // The default export uses global fetch for capture; intercept it here and
  // restore in finally (isolate:false makes a leak cross-file).
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (href.includes(POSTHOG_CAPTURE_PATH)) {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200 } as Response;
    }
    return { ok: true, status: 200, json: async () => POOLS } as Response;
  }) as unknown as typeof fetch;
  try {
    const env = {
      ...TELEMETRY_ENV,
      // A binding that throws is a genuinely unhandled fault -- nothing on the
      // rate-limit path expects it, unlike every deliberate catch in the file.
      WSS_CONNECT_RATE_LIMITER: {
        limit: async () => {
          throw new TypeError("binding exploded");
        },
      },
    } as unknown as WssLbEnv;
    const waits: Promise<unknown>[] = [];
    const res = await wssLb.fetch(wsRequest("/finney"), env, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    assert.equal(res.status, 500);
    assert.equal(
      ((await res.json()) as { error: { code: string } }).error.code,
      "internal_error",
    );
    await Promise.all(waits);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].event, "$exception");
    const props = captured[0].properties as Record<string, unknown>;
    assert.equal(props.route, "wss-lb-unhandled-exception");
    const list = props.$exception_list as Array<Record<string, unknown>>;
    assert.equal(list[0].type, "TypeError");

    // Same crash again inside the window: 500 again, but no second event.
    const res2 = await wssLb.fetch(wsRequest("/finney"), env, {
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    assert.equal(res2.status, 500);
    await Promise.all(waits);
    assert.equal(captured.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the default export also serves without an ExecutionContext (no waitUntil)", async () => {
  resetModuleState();
  const wssLb = (await import("../workers/wss-lb.ts")).default;
  const captured: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href =
      typeof input === "string"
        ? input
        : "url" in input
          ? input.url
          : String(input);
    if (href.includes(POSTHOG_CAPTURE_PATH)) {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return { ok: true, status: 200 } as Response;
    }
    return { ok: true, status: 200, json: async () => POOLS } as Response;
  }) as unknown as typeof fetch;
  try {
    const env = {
      ...TELEMETRY_ENV,
      WSS_CONNECT_RATE_LIMITER: {
        limit: async () => {
          throw new TypeError("binding exploded");
        },
      },
    } as unknown as WssLbEnv;
    // No ctx at all: capture still fires (the promise is simply left to the
    // runtime), and the 500 still serves.
    const res = await wssLb.fetch(wsRequest("/finney"), env);
    assert.equal(res.status, 500);
    // The unawaited capture resolves on the microtask queue; drain it before
    // restoring global fetch (isolate:false makes a late write cross-file).
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].event, "$exception");
  } finally {
    globalThis.fetch = realFetch;
  }
});
