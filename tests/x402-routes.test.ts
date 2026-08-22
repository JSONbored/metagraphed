// infra#629: x402 where it is actually wired -- the router, not the module.
//
// tests/x402.test.ts proves the protocol logic in isolation. This file proves
// the three things only the integration can show:
//
//   1. THE INVARIANT HOLDS THROUGH THE ROUTER. A call with no payment header
//      reaches its handler exactly as it does today. Our own website calls
//      /api/v1/ask anonymously from the Ask feature and the command palette,
//      with no credential -- a browser cannot hold one, because a key in
//      client JS is public. If this file ever fails, the product broke.
//   2. A settled payment's receipt survives the handler's response, rather
//      than being dropped by the Response reconstruction around it.
//   3. The manifest 404s where the deployment cannot take money.
//
// The handlers themselves degrade to 503 without AI bindings, which is both
// expected and irrelevant here: every assertion below is about the GATE's
// decision, which is made before the handler runs and applied after it
// returns. Asserting on a 503 body would be testing the wrong module.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import { X402_RESPONSE_HEADER, X402_SIGNATURE_HEADER } from "../src/x402.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const PAY_TO = "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f";
const paid = () => mockEnv({ X402_PAY_TO: PAY_TO });

function ask(headers: Record<string, string> = {}) {
  return new Request("https://api.metagraph.sh/api/v1/ask", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ question: "what is subnet 1" }),
  });
}

/**
 * Stub the global fetch for the duration of one call.
 *
 * The gate calls `verifyAndSettle` with no fetchImpl, so it resolves the
 * global at call time -- which is the arm the unit tests, who always inject,
 * can never reach.
 */
async function withFetch(stub: typeof fetch, fn: () => Promise<Response>) {
  const orig = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/** Answers the facilitator's two endpoints; refuses anything else loudly. */
function facilitator(verify: Row, settle: Row) {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/verify"))
      return new Response(JSON.stringify(verify), { status: 200 });
    if (href.includes("/settle"))
      return new Response(JSON.stringify(settle), { status: 200 });
    // Not a facilitator call. The handler degrades on its own without network.
    return new Response("null", { status: 503 });
  }) as unknown as typeof fetch;
}

describe("the invariant, through the router", () => {
  test("no payment header NEVER produces a 402", async () => {
    // The single most important assertion in this feature. x402 is additive:
    // it sells headroom, it does not install a paywall.
    const res = await withFetch(facilitator({}, {}), () =>
      handleRequest(ask(), paid()),
    );
    assert.notEqual(res.status, 402);
    assert.equal(res.headers.get(X402_RESPONSE_HEADER), null);
  });

  test("still no 402 when the deployment cannot take payments at all", async () => {
    const res = await withFetch(facilitator({}, {}), () =>
      handleRequest(ask(), mockEnv({})),
    );
    assert.notEqual(res.status, 402);
  });

  test("a payment on an unpriced route is ignored, not rejected", async () => {
    // /api/v1/health is free and stays free. A caller who attaches a payment
    // to it must not be charged, and must not be refused either.
    const res = await withFetch(facilitator({ isValid: false }, {}), () =>
      handleRequest(
        new Request("https://api.metagraph.sh/api/v1/health", {
          headers: { [X402_SIGNATURE_HEADER]: btoa("{}") },
        }),
        paid(),
      ),
    );
    assert.notEqual(res.status, 402);
    assert.equal(res.headers.get(X402_RESPONSE_HEADER), null);
  });
});

describe("a presented payment", () => {
  test("settles, and the receipt survives the handler's response", async () => {
    const res = await withFetch(
      facilitator(
        { isValid: true, payer: "0xpayer" },
        { success: true, payer: "0xpayer", transaction: "0xtx" },
      ),
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: btoa("{}") }), paid()),
    );
    const receipt = res.headers.get(X402_RESPONSE_HEADER);
    assert.ok(receipt, "the settlement receipt must reach the caller");
    assert.equal((JSON.parse(atob(receipt!)) as Row).transaction, "0xtx");
  });

  test("an unattributable payment still settles, and buys nothing", async () => {
    // The facilitator confirmed the money moved but named no payer. Refusing
    // here would take the payment and deny the call; inventing a payer would
    // put every anonymous payment in one shared budget, so the request simply
    // proceeds on the anonymous bucket with its receipt attached.
    const res = await withFetch(
      facilitator({ isValid: true }, { success: true, transaction: "0xtx" }),
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: btoa("{}") }), paid()),
    );
    assert.notEqual(res.status, 402);
    assert.ok(res.headers.get(X402_RESPONSE_HEADER));
  });

  test("unreadable is 400, not 402 -- paying again cannot fix an encoding", async () => {
    const res = await withFetch(facilitator({}, {}), () =>
      handleRequest(ask({ [X402_SIGNATURE_HEADER]: "!!!" }), paid()),
    );
    assert.equal(res.status, 400);
    assert.equal(
      ((await jsonBody(res)).error as Row).code,
      "x402_malformed_payment",
    );
    assert.equal(
      res.headers.get("x-metagraph-error-code"),
      "x402_malformed_payment",
    );
  });

  test("rejected is 402 with the quote reattached, so a retry is possible", async () => {
    const res = await withFetch(
      facilitator({ isValid: false, invalidReason: "insufficient_funds" }, {}),
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: btoa("{}") }), paid()),
    );
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"), "the quote must come back");
  });

  test("a facilitator outage is 402, never a free pass", async () => {
    // Fails CLOSED. The rate limiter fails open so an outage cannot deny a
    // paying caller; this control cannot, because failing open here serves
    // paid work free to anyone who notices the outage.
    const res = await withFetch(
      (async () => {
        throw new Error("facilitator unreachable");
      }) as unknown as typeof fetch,
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: btoa("{}") }), paid()),
    );
    assert.equal(res.status, 402);
  });
});

describe("GET /.well-known/x402", () => {
  const manifest = (env: Env) =>
    handleRequest(
      new Request("https://api.metagraph.sh/.well-known/x402"),
      env,
    );

  test("404s when the deployment accepts no payments", async () => {
    // Advertising payability nothing can honour is the dishonesty #11175
    // refused for an A2A card with no endpoint behind it.
    const res = await manifest(mockEnv({}));
    assert.equal(res.status, 404);
    assert.equal(((await jsonBody(res)).error as Row).code, "not_found");
  });

  test("names the address, the network, and what is free", async () => {
    const res = await manifest(paid());
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    assert.equal(body.payTo, PAY_TO);
    assert.equal(body.network, "eip155:84532");
    assert.ok((body.resources as Row[]).length > 0);
    assert.match(String(body.free), /auth\.md$/);
  });

  test("is cacheable and cross-origin readable, like every discovery doc", async () => {
    const res = await manifest(paid());
    assert.match(String(res.headers.get("cache-control")), /max-age=300/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
