// A service binding can REJECT, not merely return a bad status. Every proxy in
// workers/api.ts that forwards to DATA_API used to call `await
// env.DATA_API.fetch(...)` bare, so an unreachable upstream -- Hyperdrive down,
// the upstream Worker over its duration limit, the binding present but failing
// at runtime -- threw. handleRequest has no top-level try/catch and
// api.entry.ts stopped wrapping when Sentry was removed, so that rejection
// surfaced as an opaque 500.
//
// The distinction these tests pin down is deliberate:
//   - binding ABSENT      -> 503 (already covered elsewhere)
//   - binding THROWS      -> 503, same code  <-- this file
//   - body UNREADABLE     -> 502, same code
// A caller cannot act on a 500. It can act on "this tier is unreachable".
//
// This matters most in the situation it was least tested for: when the Postgres
// tier goes away permanently, every one of these paths throws rather than
// degrades, and the whole public surface reads as broken rather than honestly
// degraded.
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

// The chain-events proxy is the one public READ family with no fail-empty path
// and no artifact fallback, so an unreachable upstream is the difference
// between a structured 503 and a 500 for /chain-events, /chain-events/stats,
// ownership-history, conviction and lease/history.
test("chain-events proxy answers 503 when DATA_API throws", async () => {
  await expectUnreachable(
    req("/api/v1/chain-events?limit=1"),
    "data_tier_unavailable",
  );
});

// HEAD is rewritten to GET before forwarding (so the upstream does not 405), so
// it takes a different construction path to the same fetch and needs its own
// assertion rather than being assumed equivalent.
test("chain-events proxy answers 503 when DATA_API throws on a HEAD request", async () => {
  const res = await handleRequest(
    req("/api/v1/chain-events?limit=1", { method: "HEAD" }),
    throwingDataApi(),
    {},
  );
  assert.equal(res.status, 503);
});
