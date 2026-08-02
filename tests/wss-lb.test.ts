// Unit tests for the WSS load balancer Worker (workers/wss-lb.ts), which
// replaces the Railway Node service in deploy/wss-lb.
//
// The routing DECISION (selectWssUpstreams) is already covered by
// deploy/wss-lb/test/select.test.ts and is imported unchanged, so it is not
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
  dialUpstream,
  handleWssLbRequest,
  loadPools,
  type WssLbEnv,
} from "../workers/wss-lb.ts";

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

test("health endpoint reports the configured networks", async () => {
  const res = await handleWssLbRequest(
    new Request("https://wss.metagraph.sh/health"),
    {} as WssLbEnv,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; networks: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.networks, ["finney", "test"]);
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

test("loadPools accepts both the enveloped and bare artifact shapes", async () => {
  const enveloped = await loadPools(
    {} as WssLbEnv,
    poolsFetch({ data: POOLS }),
  );
  assert.equal(enveloped?.pools?.length, 1);
  const bare = await loadPools({} as WssLbEnv, poolsFetch(POOLS));
  assert.equal(bare?.pools?.length, 1);
});
