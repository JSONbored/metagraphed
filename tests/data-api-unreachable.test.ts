// A service binding can REJECT, not merely return a bad status. Every proxy in
// workers/api.ts that forwards to DATA_API used to call `await
// env.DATA_API.fetch(...)` bare, so an unreachable upstream -- Hyperdrive down,
// the upstream Worker over its duration limit, the binding present but failing
// at runtime -- threw. handleRequest has no top-level try/catch and
// api.entry.ts stopped wrapping when Sentry was removed, so that rejection
// surfaced as an opaque 500.
//
// The distinction these tests pin down is deliberate, and #9146 split it by
// what the route DOES rather than by how it fails:
//   - user-state WRITES (alerts, auth, keys) -> 503 on absent/throwing binding.
//     Inventing an empty success for a write would be a lie.
//   - public READS (the six chain-events-proxied routes) -> 200 + the
//     schema-stable empty, marked x-metagraph-degraded. They are the only
//     routes with no METAGRAPH_*_SOURCE flag, so they were the only ones that
//     still erred once the Postgres box went away.
//
// A caller cannot act on a 500. It can act on "this tier is unreachable" -- and
// for a read it can act better still on an empty that says so in a header,
// because the payload still parses against the published schema.
//
// That last part is the situation this file was written for and least tested
// for: when the Postgres tier went away permanently, every one of these paths
// threw rather than degraded, and the public surface read as broken rather
// than honestly degraded. The read half of that is now fixed.
import assert from "node:assert/strict";
import { test } from "vitest";
import { handleRequest } from "../workers/api.ts";

// A binding whose fetch rejects, which is what an unreachable upstream does --
// as opposed to resolving with a 5xx, which the proxies already handled.
function throwingDataApi() {
  return {
    DATA_API: {
      fetch: () => {
        throw new Error("upstream unreachable");
      },
    },
  } as unknown as Env;
}

function req(
  path: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  return new Request(`https://api.metagraph.sh${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function expectUnreachable(
  request: Request,
  expectedCode: string,
): Promise<void> {
  const res = await handleRequest(request, throwingDataApi(), {});
  const payload = (await res.json()) as {
    ok: boolean;
    error?: { code?: string };
  };
  assert.equal(
    res.status,
    503,
    `expected 503 for ${request.method} ${new URL(request.url).pathname}, got ${res.status}`,
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.error?.code, expectedCode);
}

test("alert-triggers proxy answers 503 when DATA_API throws", async () => {
  await expectUnreachable(
    req("/api/v1/alerts/triggers", {
      method: "POST",
      headers: { "x-alert-trigger-create-token": "shared-secret" },
      body: { channel: "email", destination: "a@b.com", netuid: 7 },
    }),
    "alert_triggers_unavailable",
  );
});

test("wallet-auth proxy answers 503 when DATA_API throws", async () => {
  await expectUnreachable(
    req("/api/v1/auth/wallet/verify", {
      method: "POST",
      body: { ss58: "5Test", signature: "0xdead" },
    }),
    "wallet_auth_unavailable",
  );
});

test("watch-auth proxy answers 503 when DATA_API throws", async () => {
  await expectUnreachable(
    req("/api/v1/watch/tokens", {
      method: "POST",
      body: { ss58: "5Test", signature: "0xdead" },
    }),
    "watch_auth_unavailable",
  );
});

test("account-keys proxy answers 503 when DATA_API throws", async () => {
  await expectUnreachable(
    req("/api/v1/keys", {
      method: "GET",
      headers: { authorization: "Bearer session-token" },
    }),
    "account_keys_unavailable",
  );
});

// The chain-events family NO LONGER 503s here (#9146). This file's own header
// named the situation it was least tested for -- "when the Postgres tier goes
// away permanently, every one of these paths throws rather than degrades, and
// the whole public surface reads as broken rather than honestly degraded" --
// and that is exactly what happened: all six answered 502/503 in production
// once the box was decommissioned.
//
// They now degrade to the schema-stable empty every FLAGGED tier already
// returned, marked with x-metagraph-degraded so the payload is barred from the
// edge cache and a caller can tell "no events" from "we could not look". The
// remaining proxies above keep their 503: those are user-state writes
// (alerts/auth/keys), where inventing an empty success would be wrong.
test("chain-events proxy degrades instead of erroring when DATA_API throws", async () => {
  const res = await handleRequest(
    req("/api/v1/chain-events?limit=1"),
    throwingDataApi(),
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-metagraph-degraded"), "tier_unavailable");
  const payload = (await res.json()) as {
    ok: boolean;
    data?: { events?: unknown[]; count?: number };
  };
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data?.events, []);
  assert.equal(payload.data?.count, 0);
});

// HEAD is rewritten to GET before forwarding (so the upstream does not 405), so
// it takes a different construction path to the same fetch and needs its own
// assertion rather than being assumed equivalent.
test("chain-events proxy degrades on a HEAD request too", async () => {
  const res = await handleRequest(
    req("/api/v1/chain-events?limit=1", { method: "HEAD" }),
    throwingDataApi(),
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-metagraph-degraded"), "tier_unavailable");
});
