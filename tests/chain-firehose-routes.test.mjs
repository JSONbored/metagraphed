// Unit tests for workers/api.mjs's two chain-firehose routes (#4982, ADR
// 0015): the public GET /api/v1/chain/stream forwarder and the internal
// POST /api/v1/internal/chain-firehose-ingest auth+forward. The Durable
// Object's own decision logic is covered by tests/chain-firehose-hub.test.mjs;
// these tests only cover the routing/auth boundary in workers/api.mjs,
// mirroring tests/neurons-sync-proxy.test.mjs's shape for the equivalent
// DATA_API-proxied internal routes.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.mjs";

function stubHub(fetchImpl) {
  return {
    idFromName: (name) => `id:${name}`,
    get: (id) => ({
      fetch: (input, init) => fetchImpl(input, init, id),
    }),
  };
}

// --- GET /api/v1/chain/stream ---------------------------------------------------

test("chain/stream: 503s when CHAIN_FIREHOSE_HUB is not bound", async () => {
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/stream"),
    {},
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "chain_firehose_unavailable");
});

test("chain/stream: forwards to the hub's /subscribe path, preserving the query string, on the fixed 'global' id", async () => {
  let forwardedUrl;
  let forwardedId;
  const env = {
    CHAIN_FIREHOSE_HUB: stubHub((request, _init, id) => {
      forwardedUrl = new URL(request.url);
      forwardedId = id;
      return new Response("stream", { status: 200 });
    }),
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/stream?topics=blocks"),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(forwardedId, "id:global");
  assert.equal(forwardedUrl.pathname, "/subscribe");
  assert.equal(forwardedUrl.searchParams.get("topics"), "blocks");
});

test("chain/stream: preserves the Upgrade header so a WebSocket handshake reaches the hub unchanged", async () => {
  // Node's Response constructor rejects status 101 outside a real WebSocket
  // upgrade (that shape only exists in the actual Workers runtime) -- this
  // test only needs to confirm the header survives the forward, so the stub
  // replies 200 rather than attempting to construct a real 101.
  let receivedUpgrade;
  const env = {
    CHAIN_FIREHOSE_HUB: stubHub((request) => {
      receivedUpgrade = request.headers.get("upgrade");
      return new Response(null, { status: 200 });
    }),
  };
  const res = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/chain/stream", {
      headers: { upgrade: "websocket" },
    }),
    env,
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(receivedUpgrade, "websocket");
});

// --- POST /api/v1/internal/chain-firehose-ingest --------------------------------

function ingestRequest(body, { method = "POST", token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token !== undefined) headers["x-chain-firehose-sync-token"] = token;
  return new Request(
    "https://api.metagraph.sh/api/v1/internal/chain-firehose-ingest",
    {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    },
  );
}

test("ingest: rejects non-POST before checking auth (405)", async () => {
  const res = await handleRequest(
    ingestRequest(null, { method: "GET" }),
    { CHAIN_FIREHOSE_SYNC_SECRET: "shh" },
    {},
  );
  assert.equal(res.status, 405);
});

test("ingest: 503s when CHAIN_FIREHOSE_SYNC_SECRET is unprovisioned", async () => {
  const res = await handleRequest(ingestRequest("{}"), {}, {});
  assert.equal(res.status, 503);
  assert.equal(
    (await res.json()).error.code,
    "chain_firehose_ingest_unavailable",
  );
});

test("ingest: 401s when the token header is missing", async () => {
  const res = await handleRequest(
    ingestRequest("{}"),
    { CHAIN_FIREHOSE_SYNC_SECRET: "shh" },
    {},
  );
  assert.equal(res.status, 401);
});

test("ingest: 401s when the token header is wrong", async () => {
  const res = await handleRequest(
    ingestRequest("{}", { token: "nope" }),
    { CHAIN_FIREHOSE_SYNC_SECRET: "shh" },
    {},
  );
  assert.equal(res.status, 401);
  assert.equal(
    (await res.json()).error.code,
    "chain_firehose_ingest_unauthorized",
  );
});

test("ingest: 503s (after auth passes) when CHAIN_FIREHOSE_HUB is not bound", async () => {
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    { CHAIN_FIREHOSE_SYNC_SECRET: "shh" },
    {},
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "chain_firehose_unavailable");
});

test("ingest: on valid auth, forwards the body to the hub's /ingest path on the fixed 'global' id and relays its response", async () => {
  let forwardedUrl;
  let forwardedBody;
  let forwardedId;
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_HUB: stubHub((input, init, id) => {
      forwardedUrl = input;
      forwardedBody = init.body;
      forwardedId = id;
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }),
  };
  const res = await handleRequest(
    ingestRequest(JSON.stringify({ table: "blocks", block_number: 1 }), {
      token: "shh",
    }),
    env,
    {},
  );
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(forwardedId, "id:global");
  assert.equal(forwardedUrl, "https://chain-firehose-hub.internal/ingest");
  assert.equal(
    forwardedBody,
    JSON.stringify({ table: "blocks", block_number: 1 }),
  );
});

// #5550: the ingest write path fans each payload out to every live firehose
// subscriber, so a leaked secret needs a volume cap, not just auth.
test("ingest: a within-limit request passes the rate limiter and reaches the hub (#5550)", async () => {
  let forwarded = false;
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_INGEST_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
    CHAIN_FIREHOSE_HUB: stubHub(() => {
      forwarded = true;
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }),
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    env,
    {},
  );
  assert.equal(res.status, 202);
  assert.ok(forwarded, "a within-limit request must reach the hub");
});

test("ingest: an over-limit request 429s with the rate-limit header family and never reaches the hub (#5550)", async () => {
  let forwarded = false;
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_INGEST_RATE_LIMITER: {
      limit: async () => ({ success: false }),
    },
    CHAIN_FIREHOSE_HUB: stubHub(() => {
      forwarded = true;
      return new Response("{}", { status: 202 });
    }),
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    env,
    {},
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("x-ratelimit-limit"), "1200");
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
  assert.ok(res.headers.get("x-ratelimit-policy"));
  assert.equal(
    forwarded,
    false,
    "an over-limit request must not reach the hub",
  );
});

test("ingest: an unbound rate limiter is a no-op (local dev/CI) (#5550)", async () => {
  let forwarded = false;
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    // No CHAIN_FIREHOSE_INGEST_RATE_LIMITER binding at all.
    CHAIN_FIREHOSE_HUB: stubHub(() => {
      forwarded = true;
      return new Response("{}", { status: 202 });
    }),
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    env,
    {},
  );
  assert.equal(res.status, 202);
  assert.ok(forwarded);
});

test("ingest: a wrong token 401s before the limiter is consulted (#5550)", async () => {
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_INGEST_RATE_LIMITER: {
      limit: async () => {
        throw new Error(
          "limiter must not be consulted for an unauthenticated caller",
        );
      },
    },
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "nope" }),
    env,
    {},
  );
  assert.equal(res.status, 401);
});

// Sentry METAGRAPHED-1: a DO stub call throws "Durable Object reset because
// its code was updated" when a deploy touching ChainFirehoseHub lands
// mid-request -- expected/occasional, not a real fault. Left uncaught this
// was an unhandled Worker exception instead of a clean, retryable response.
test("ingest: a DO stub call throwing (e.g. a mid-request deploy reset) 503s cleanly instead of throwing (Sentry METAGRAPHED-1)", async () => {
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_HUB: stubHub(() => {
      throw new Error("Durable Object reset because its code was updated.");
    }),
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    env,
    {},
  );
  assert.equal(res.status, 503);
  assert.equal(
    (await res.json()).error.code,
    "chain_firehose_ingest_unavailable",
  );
  assert.ok(res.headers.get("retry-after"));
});

test("ingest: relays a non-2xx upstream status (e.g. 400 from an invalid payload) unchanged", async () => {
  const env = {
    CHAIN_FIREHOSE_SYNC_SECRET: "shh",
    CHAIN_FIREHOSE_HUB: stubHub(
      () =>
        new Response(JSON.stringify({ error: "table must be one of ..." }), {
          status: 400,
        }),
    ),
  };
  const res = await handleRequest(
    ingestRequest("{}", { token: "shh" }),
    env,
    {},
  );
  assert.equal(res.status, 400);
});
