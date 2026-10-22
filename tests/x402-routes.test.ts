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
// Valid payment fixtures enable the AI bindings. The fixture model deliberately
// fails after admission: payment assertions concern the gate, while unavailable
// bindings and invalid inputs must be rejected before any money can move.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "vitest";
import { handleRequest } from "../workers/api.ts";
import {
  X402_RESPONSE_HEADER,
  X402_SIGNATURE_HEADER,
  paymentRequirements,
  resolveX402Config,
  x402PriceFor,
} from "../src/x402.ts";
import { createX402Fixture } from "./x402-fixtures.ts";
import { MAX_ASK_BODY_BYTES } from "../workers/config.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { jsonBody, mockEnv, type Row } from "./row-type.ts";

const PAY_TO = "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f";
const PAY_TO_SOL = "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87";
const fixtures: ReturnType<typeof createX402Fixture>[] = [];
const envWithDb = (values: Record<string, unknown>) => {
  const fixture = createX402Fixture();
  fixtures.push(fixture);
  return mockEnv({
    D1_STATE: fixture.db,
    D1_STATE_TABLES: "x402_payment_attempts",
    ...values,
  });
};
const paid = (overrides: Record<string, unknown> = {}) =>
  envWithDb({
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      run: async () => {
        throw new Error("fixture model unavailable");
      },
    },
    VECTORIZE: { query: async () => ({ matches: [] }) },
    X402_PAY_TO: PAY_TO,
    X402_NETWORK: "eip155:8453",
    X402_FACILITATOR_URL: "https://facilitator.payai.network",
    ...overrides,
  });
const accepted = paymentRequirements(
  resolveX402Config(
    mockEnv({ X402_PAY_TO: PAY_TO, X402_NETWORK: "eip155:8453" }),
  )!,
  "10000",
)[0];
const payment = btoa(
  JSON.stringify({
    x402Version: 2,
    accepted,
    payload: {
      signature: "signed",
      authorization: {
        from: "0x" + "a".repeat(40),
        nonce: "0x" + "b".repeat(64),
      },
    },
  }),
);
beforeEach(() => resetModuleState());
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));

function assertPaymentHeadersReadable(response: Response) {
  const exposed = response.headers
    .get("access-control-expose-headers")
    ?.split(", ");
  assert.ok(exposed?.includes("payment-required"));
  assert.ok(exposed?.includes("payment-response"));
}

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
    if (href.endsWith("/supported"))
      return Response.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:8453" },
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          {
            x402Version: 2,
            scheme: "exact",
            network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
            extra: { feePayer: PAY_TO_SOL },
          },
        ],
      });
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
          headers: { [X402_SIGNATURE_HEADER]: payment },
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
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
    );
    const receipt = res.headers.get(X402_RESPONSE_HEADER);
    assert.ok(receipt, "the settlement receipt must reach the caller");
    assert.equal((JSON.parse(atob(receipt!)) as Row).transaction, "0xtx");
    assertPaymentHeadersReadable(res);
  });

  test("an unattributable payment still settles, and buys nothing", async () => {
    // The facilitator confirmed the money moved but named no payer. Refusing
    // here would take the payment and deny the call; inventing a payer would
    // put every anonymous payment in one shared budget, so the request simply
    // proceeds on the anonymous bucket with its receipt attached.
    const res = await withFetch(
      facilitator({ isValid: true }, { success: true, transaction: "0xtx" }),
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
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
    assertPaymentHeadersReadable(res);
  });

  test("rejected is 402 with the quote reattached, so a retry is possible", async () => {
    const res = await withFetch(
      facilitator({ isValid: false, invalidReason: "insufficient_funds" }, {}),
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
    );
    assert.equal(res.status, 402);
    assert.ok(res.headers.get("payment-required"), "the quote must come back");
    assertPaymentHeadersReadable(res);
  });

  test("a facilitator outage is 503 without a new quote or paid work", async () => {
    // Fails CLOSED. The rate limiter fails open so an outage cannot deny a
    // paying caller; this control cannot, because failing open here serves
    // paid work free to anyone who notices the outage.
    const res = await withFetch(
      (async () => {
        throw new Error("facilitator unreachable");
      }) as unknown as typeof fetch,
      () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("payment-required"), null);
    assertPaymentHeadersReadable(res);
  });
});

describe("browser payment preflights", () => {
  test.each([
    ["/api/v1/export/chain-events", "GET", "GET, HEAD, OPTIONS"],
    ["/api/v1/blocks", "GET", "GET, HEAD, OPTIONS"],
    ["/api/v1/ask", "POST", "POST, OPTIONS"],
  ])("does not charge OPTIONS on %s", async (path, method, allowedMethods) => {
    const calls: string[] = [];
    const res = await withFetch(
      (async (url: string | URL | Request) => {
        calls.push(String(url));
        throw new Error("a preflight must not verify or settle a payment");
      }) as typeof fetch,
      () =>
        handleRequest(
          new Request(`https://api.metagraph.sh${path}`, {
            method: "OPTIONS",
            headers: {
              origin: "https://browser.example",
              "access-control-request-method": method,
              "access-control-request-headers": "payment-signature, signature",
              "payment-signature": "!!!",
            },
          }),
          paid(),
        ),
    );
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      allowedMethods,
    );
    assert.ok(
      res.headers
        .get("access-control-allow-headers")
        ?.split(", ")
        .includes("payment-signature"),
    );
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.deepEqual(calls, []);
    assertPaymentHeadersReadable(res);
  });
});

describe("payment method preflight", () => {
  test.each([
    ["/api/v1/export/chain-events", "POST", "GET, HEAD, OPTIONS"],
    ["/api/v1/finney/export/chain-events", "POST", "GET, HEAD, OPTIONS"],
    ["/api/v1/ask", "GET", "POST, OPTIONS"],
    ["/api/v1/finney/ask", "GET", "POST, OPTIONS"],
  ])("rejects %s %s before any payment work", async (path, method, allow) => {
    const calls: string[] = [];
    for (const signature of [undefined, payment, "!!!"]) {
      const res = await withFetch(
        (async (url: string | URL | Request) => {
          calls.push(String(url));
          throw new Error(
            "unsupported methods must never reach the facilitator",
          );
        }) as typeof fetch,
        () =>
          handleRequest(
            new Request(`https://api.metagraph.sh${path}`, {
              method,
              headers: signature ? { [X402_SIGNATURE_HEADER]: signature } : {},
            }),
            paid(),
          ),
      );
      assert.equal(res.status, 405);
      assert.equal((await jsonBody(res)).error.code, "method_not_allowed");
      assert.equal(res.headers.get("allow"), allow);
      assert.equal(res.headers.get("payment-required"), null);
      assert.equal(res.headers.get(X402_RESPONSE_HEADER), null);
    }
    assert.deepEqual(calls, []);
  });

  test.each([
    ["/api/v1/testnet/ask", "GET", 404],
    ["/api/v1/testnet/ask", "POST", 404],
    ["/api/v1/local/ask", "GET", 404],
    ["/api/v1/local/ask", "POST", 405],
  ])("keeps %s %s under network routing", async (path, method, status) => {
    const calls: string[] = [];
    for (const signature of [undefined, payment, "!!!"]) {
      const res = await withFetch(
        (async (url: string | URL | Request) => {
          calls.push(String(url));
          throw new Error("unavailable resources cannot accept payments");
        }) as typeof fetch,
        () =>
          handleRequest(
            new Request(`https://api.metagraph.sh${path}`, {
              method,
              headers: signature ? { [X402_SIGNATURE_HEADER]: signature } : {},
            }),
            paid(),
          ),
      );
      assert.equal(res.status, status);
      assert.equal(res.headers.get("payment-required"), null);
      assert.equal(res.headers.get(X402_RESPONSE_HEADER), null);
    }
    assert.deepEqual(calls, []);
  });

  test.each(["GET", "HEAD"])(
    "still settles a supported export %s",
    async (method) => {
      const env = paid();
      const acceptedExport = paymentRequirements(
        resolveX402Config(env)!,
        x402PriceFor("/api/v1/export/chain-events")!.atomicAmount,
      )[0];
      const exportPayment = JSON.parse(atob(payment)) as Row;
      exportPayment.accepted = acceptedExport;
      const res = await withFetch(
        facilitator(
          { isValid: true, payer: "0xpayer" },
          { success: true, payer: "0xpayer", transaction: "0xtx" },
        ),
        () =>
          handleRequest(
            new Request("https://api.metagraph.sh/api/v1/export/chain-events", {
              method,
              headers: {
                [X402_SIGNATURE_HEADER]: btoa(JSON.stringify(exportPayment)),
              },
            }),
            env,
          ),
      );
      const receipt = res.headers.get(X402_RESPONSE_HEADER);
      assert.ok(receipt);
      assert.equal((JSON.parse(atob(receipt)) as Row).transaction, "0xtx");
    },
  );
});

describe("payment route and input preflight", () => {
  test.each([
    ["/api/v1/export/not-a-route", "GET"],
    ["/api/v1/export/not-a-route", "POST"],
    ["/api/v1/blocks/1/not-a-route", "GET"],
    ["/api/v1/blocks/1/not-a-route", "POST"],
    ["/api/v1/export/chain-events/", "GET"],
    ["/api/v1/export/chain-events/", "POST"],
    ["/api/v1/blocks/1/", "GET"],
    ["/api/v1/ask/", "POST"],
    ["/api/v1/search/semantic/not-a-route", "GET"],
  ])(
    "never quotes or settles a missing canonical route: %s %s",
    async (path, method) => {
      for (const signature of [undefined, payment, "!!!"]) {
        const env = paid();
        const fixture = fixtures.at(-1)!;
        const calls: string[] = [];
        const response = await withFetch(
          (async (url) => {
            calls.push(String(url));
            throw new Error("missing routes must not contact the facilitator");
          }) as typeof fetch,
          () =>
            handleRequest(
              new Request(`https://api.metagraph.sh${path}`, {
                method,
                headers: signature
                  ? { [X402_SIGNATURE_HEADER]: signature }
                  : {},
              }),
              env,
            ),
        );
        assert.equal(response.status, 404);
        assert.equal(response.headers.get("payment-required"), null);
        assert.equal(response.headers.get(X402_RESPONSE_HEADER), null);
        assert.deepEqual(calls, []);
        assert.equal(
          fixture.sql
            .prepare("SELECT count(*) AS count FROM x402_payment_attempts")
            .get()?.count,
          0,
        );
      }
    },
  );

  test.each([
    ["malformed JSON", "{", 400, "invalid_json"],
    ["empty body", undefined, 400, "invalid_json"],
    ["non-object JSON", "null", 400, "invalid_request"],
    ["missing question", "{}", 400, "invalid_request"],
    [
      "blank question",
      JSON.stringify({ question: "   " }),
      400,
      "invalid_request",
    ],
    [
      "long question",
      JSON.stringify({ question: "x".repeat(1001) }),
      400,
      "invalid_request",
    ],
    [
      "invalid type",
      JSON.stringify({ question: "valid", type: "bogus" }),
      400,
      "invalid_request",
    ],
    [
      "oversized body",
      JSON.stringify({
        question: "valid",
        padding: "x".repeat(MAX_ASK_BODY_BYTES),
      }),
      413,
      "payload_too_large",
    ],
  ] as const)(
    "rejects %s before settlement and leaves payment reusable",
    async (_label, body, status, code) => {
      const env = paid();
      const fixture = fixtures.at(-1)!;
      const calls: string[] = [];
      const response = await withFetch(
        (async (url) => {
          calls.push(String(url));
          throw new Error("invalid input must not contact the facilitator");
        }) as typeof fetch,
        () =>
          handleRequest(
            new Request("https://api.metagraph.sh/api/v1/ask", {
              method: "POST",
              headers: { [X402_SIGNATURE_HEADER]: payment },
              body,
            }),
            env,
          ),
      );
      assert.equal(response.status, status);
      assert.equal((await jsonBody(response)).error.code, code);
      assert.equal(response.headers.get("payment-required"), null);
      assert.equal(response.headers.get(X402_RESPONSE_HEADER), null);
      assert.deepEqual(calls, []);
      assert.equal(
        fixture.sql
          .prepare("SELECT count(*) AS count FROM x402_payment_attempts")
          .get()?.count,
        0,
      );
      const corrected = await withFetch(
        facilitator({ isValid: true }, { success: true }),
        () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), env),
      );
      assert.ok(corrected.headers.get(X402_RESPONSE_HEADER));
    },
  );

  test.each([
    [
      "/api/v1/accounts/5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs912/events",
      "invalid_ss58",
    ],
    ["/api/v1/subnets/65536/lease", "invalid_netuid"],
    ["/api/v1/subnets/9007199254740992/ownership-history", "invalid_netuid"],
    ["/api/v1/blocks/9007199254740992", "invalid_block_ref"],
    ["/api/v1/blocks/9007199254740992/events", "invalid_block_ref"],
    ["/api/v1/extrinsics/9007199254740992-0", "invalid_extrinsic_ref"],
    ["/api/v1/extrinsics/1-9007199254740992", "invalid_extrinsic_ref"],
    ["/api/v1/search/semantic", "invalid_query"],
    ["/api/v1/search/semantic?q=", "invalid_query"],
    ["/api/v1/search/semantic?q=%20%20", "invalid_query"],
    ["/api/v1/chain-events?pallet=bad-name", "invalid_query"],
  ])(
    "rejects unusable paid path/query values before settlement: %s",
    async (path, code) => {
      const env = paid();
      const fixture = fixtures.at(-1)!;
      const calls: string[] = [];
      const response = await withFetch(
        (async (url) => {
          calls.push(String(url));
          throw new Error("unusable values must not contact the facilitator");
        }) as typeof fetch,
        () =>
          handleRequest(
            new Request(`https://api.metagraph.sh${path}`, {
              headers: { [X402_SIGNATURE_HEADER]: payment },
            }),
            env,
          ),
      );
      assert.equal(response.status, 400);
      assert.equal((await jsonBody(response)).error.code, code);
      assert.equal(response.headers.get("payment-required"), null);
      assert.equal(response.headers.get(X402_RESPONSE_HEADER), null);
      assert.deepEqual(calls, []);
      assert.equal(
        fixture.sql
          .prepare("SELECT count(*) AS count FROM x402_payment_attempts")
          .get()?.count,
        0,
      );
    },
  );

  test.each([
    "/api/v1/blocks/1",
    "/api/v1/blocks/0x" + "a".repeat(64),
    "/api/v1/extrinsics/1-0",
    "/api/v1/extrinsics/0x" + "a".repeat(64),
    "/api/v1/subnets/1/lease/history",
    "/api/v1/chain-events",
    "/api/v1/search/semantic?q=valid",
  ])("retains valid payments on %s", async (path) => {
    const env = paid();
    const selected = JSON.parse(atob(payment)) as Row;
    selected.accepted = paymentRequirements(
      resolveX402Config(env)!,
      x402PriceFor(path)!.atomicAmount,
    )[0];
    const response = await withFetch(
      facilitator({ isValid: true }, { success: true }),
      () =>
        handleRequest(
          new Request(`https://api.metagraph.sh${path}`, {
            headers: {
              [X402_SIGNATURE_HEADER]: btoa(JSON.stringify(selected)),
            },
          }),
          env,
        ),
    );
    assert.ok(response.headers.get(X402_RESPONSE_HEADER));
  });

  test("refuses a declared oversized body without reading or settling it", async () => {
    const calls: string[] = [];
    const response = await withFetch(
      (async (url) => {
        calls.push(String(url));
        throw new Error("oversized input must not contact the facilitator");
      }) as typeof fetch,
      () =>
        handleRequest(
          new Request("https://api.metagraph.sh/api/v1/ask", {
            method: "POST",
            headers: {
              [X402_SIGNATURE_HEADER]: payment,
              "content-length": String(MAX_ASK_BODY_BYTES + 1),
            },
            body: JSON.stringify({ question: "valid" }),
          }),
          paid(),
        ),
    );
    assert.equal(response.status, 413);
    assert.equal((await jsonBody(response)).error.code, "payload_too_large");
    assert.deepEqual(calls, []);
  });

  test.each([
    { METAGRAPH_ENABLE_AI: "false" },
    { AI: undefined },
    { VECTORIZE: undefined },
  ])(
    "refuses unavailable AI bindings before payment: %j",
    async (overrides) => {
      for (const path of ["/api/v1/ask", "/api/v1/search/semantic?q=subnet"]) {
        const calls: string[] = [];
        const response = await withFetch(
          (async (url) => {
            calls.push(String(url));
            throw new Error("disabled AI must not contact the facilitator");
          }) as typeof fetch,
          () =>
            handleRequest(
              path.endsWith("/ask")
                ? ask({ [X402_SIGNATURE_HEADER]: payment })
                : new Request(`https://api.metagraph.sh${path}`, {
                    headers: { [X402_SIGNATURE_HEADER]: payment },
                  }),
              paid(overrides),
            ),
        );
        assert.equal(response.status, 503);
        assert.equal((await jsonBody(response)).error.code, "ai_unavailable");
        assert.equal(response.headers.get("payment-required"), null);
        assert.equal(response.headers.get(X402_RESPONSE_HEADER), null);
        assert.deepEqual(calls, []);
      }
    },
  );

  test("validates a clone while retaining exact body bytes for payment identity", async () => {
    const env = paid();
    const rawBody = '{ "question" : "same question" }';
    const request = (body: string) =>
      new Request("https://api.metagraph.sh/api/v1/ask", {
        method: "POST",
        headers: { [X402_SIGNATURE_HEADER]: payment },
        body,
      });
    const first = await withFetch(
      facilitator({ isValid: true }, { success: true }),
      () => handleRequest(request(rawBody), env),
    );
    assert.ok(first.headers.get(X402_RESPONSE_HEADER));
    const replay = await handleRequest(request(rawBody), env);
    assert.equal((await jsonBody(replay)).error.code, "x402_payment_consumed");
    const reencoded = await handleRequest(
      request(JSON.stringify({ question: "same question" })),
      env,
    );
    assert.equal(
      (await jsonBody(reencoded)).error.code,
      "x402_payment_conflict",
    );
  });
});

describe("settled headroom survives Request normalization", () => {
  const payer = "0x" + "a".repeat(40);
  test.each(["finney", "mainnet"])(
    "the %s ask alias uses the paid AI bucket",
    async (network) => {
      const paidCalls: unknown[] = [];
      const anonymousCalls: unknown[] = [];
      const env = paid({
        AI_RATE_LIMITER: {
          limit: async (args: unknown) => {
            anonymousCalls.push(args);
            return { success: false };
          },
        },
        AI_RATE_LIMITER_PAID: {
          limit: async (args: unknown) => {
            paidCalls.push(args);
            return { success: true };
          },
        },
      });
      const response = await withFetch(
        facilitator({ isValid: true, payer }, { success: true, payer }),
        () =>
          handleRequest(
            new Request(`https://api.metagraph.sh/api/v1/${network}/ask`, {
              method: "POST",
              headers: { [X402_SIGNATURE_HEADER]: payment },
              body: JSON.stringify({ question: "valid" }),
            }),
            env,
          ),
      );
      assert.notEqual(response.status, 429);
      assert.ok(response.headers.get(X402_RESPONSE_HEADER));
      assert.deepEqual(anonymousCalls, []);
      assert.deepEqual(paidCalls, [{ key: `ai:paid:x402:${payer}` }]);
    },
  );

  test("a paid account HEAD retains its tier when the cache builds a GET", async () => {
    const paidCalls: unknown[] = [];
    const anonymousCalls: unknown[] = [];
    const env = paid({
      DATA_RATE_LIMITER: {
        limit: async (args: unknown) => {
          anonymousCalls.push(args);
          return { success: false };
        },
      },
      DATA_RATE_LIMITER_PAID: {
        limit: async (args: unknown) => {
          paidCalls.push(args);
          return { success: true };
        },
      },
    });
    const path =
      "/api/v1/accounts/5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F/events?limit=1";
    const selected = JSON.parse(atob(payment)) as Row;
    selected.accepted = paymentRequirements(
      resolveX402Config(env)!,
      x402PriceFor(path)!.atomicAmount,
    )[0];
    const response = await withFetch(
      facilitator({ isValid: true, payer }, { success: true, payer }),
      () =>
        handleRequest(
          new Request(`https://api.metagraph.sh${path}`, {
            method: "HEAD",
            headers: {
              [X402_SIGNATURE_HEADER]: btoa(JSON.stringify(selected)),
            },
          }),
          env,
        ),
    );
    assert.notEqual(response.status, 429);
    assert.ok(response.headers.get(X402_RESPONSE_HEADER));
    assert.deepEqual(anonymousCalls, []);
    assert.deepEqual(paidCalls, [{ key: `data:paid:x402:${payer}` }]);
    assert.equal(await response.text(), "");
  });
});

describe("GET /.well-known/x402", () => {
  const manifest = (env: Env) =>
    withFetch(facilitator({}, {}), () =>
      handleRequest(
        new Request("https://api.metagraph.sh/.well-known/x402"),
        env,
      ),
    );

  test("404s when the deployment accepts no payments", async () => {
    // Advertising payability nothing can honour is the dishonesty #11175
    // refused for an A2A card with no endpoint behind it.
    const res = await manifest(mockEnv({}));
    assert.equal(res.status, 404);
    assert.equal(((await jsonBody(res)).error as Row).code, "not_found");
  });

  test("names every network's address, and what is free", async () => {
    const res = await manifest(paid());
    assert.equal(res.status, 200);
    const body = await jsonBody(res);
    const accepts = body.accepts as Row[];
    assert.equal(accepts[0]!.payTo, PAY_TO);
    assert.equal(accepts[0]!.network, "eip155:8453");
    assert.ok((body.resources as Row[]).length > 0);
    assert.match(String(body.free), /auth\.md$/);
  });

  test("advertises BOTH legs when both are configured", async () => {
    // The thing the array exists for: an agent holding only SOL and one
    // holding only Base USDC must both be able to read a way to pay us.
    const res = await manifest(
      envWithDb({ X402_PAY_TO: PAY_TO, X402_PAY_TO_SOLANA: PAY_TO_SOL }),
    );
    const networks = ((await jsonBody(res)).accepts as Row[]).map((a) =>
      String(a.network),
    );
    assert.equal(networks.length, 2);
    assert.ok(networks.some((n) => n.startsWith("eip155:")));
    assert.ok(networks.some((n) => n.startsWith("solana:")));
  });

  test("a Solana-only deployment still takes payments", async () => {
    // Legs resolve independently. A misconfigured EVM leg must not silently
    // take the working Solana one down with it.
    const res = await manifest(envWithDb({ X402_PAY_TO_SOLANA: PAY_TO_SOL }));
    assert.equal(res.status, 200);
    const accepts = (await jsonBody(res)).accepts as Row[];
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]!.payTo, PAY_TO_SOL);
  });

  test("is cacheable and cross-origin readable, like every discovery doc", async () => {
    const res = await manifest(paid());
    assert.match(String(res.headers.get("cache-control")), /max-age=300/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});

test("an ambiguous broadcast returns pending with its transaction and no new payment challenge", async () => {
  const res = await withFetch(
    facilitator(
      { isValid: true },
      {
        success: false,
        errorReason: "settlement_pending",
        transaction: "broadcast",
      },
    ),
    () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
  assert.equal(res.headers.get("payment-required"), null);
  assert.equal((await jsonBody(res)).error.code, "x402_settlement_pending");
  assert.equal(
    JSON.parse(atob(res.headers.get("payment-response")!)).transaction,
    "broadcast",
  );
});

test("durable consumption denies repeat execution and use on a different request", async () => {
  const env = paid();
  const first = await withFetch(
    facilitator({ isValid: true }, { success: true }),
    () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), env),
  );
  assert.ok(first.headers.get("payment-response"));
  const replay = await withFetch(facilitator({}, {}), () =>
    handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), env),
  );
  assert.equal(replay.status, 409);
  assert.equal((await jsonBody(replay)).error.code, "x402_payment_consumed");
  assert.ok(replay.headers.get("payment-response"));
  assert.equal(replay.headers.get("payment-required"), null);
  const conflict = await handleRequest(
    new Request("https://api.metagraph.sh/api/v1/ask?different=1", {
      method: "POST",
      headers: { "payment-signature": payment },
      body: JSON.stringify({ question: "a different valid question" }),
    }),
    env,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await jsonBody(conflict)).error.code, "x402_payment_conflict");
  assert.equal(conflict.headers.get("payment-required"), null);
});

test("quotes and discovery fail closed when durable payment storage is unowned or unbound", async () => {
  for (const values of [{}, { D1_STATE_TABLES: "x402_payment_attempts" }]) {
    const env = mockEnv({ X402_PAY_TO: PAY_TO, ...values });
    for (const path of ["/.well-known/x402", "/api/v1/export/chain-events"]) {
      const res = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
      );
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("payment-required"), null);
    }
  }
});

test("optional free traffic does not discover capabilities or read payment state", async () => {
  let paymentCalls = 0;
  const response = await withFetch(
    (async () => {
      paymentCalls++;
      throw new Error("payment dependencies must stay cold");
    }) as typeof fetch,
    () => handleRequest(ask(), mockEnv({ X402_PAY_TO: PAY_TO })),
  );
  assert.notEqual(response.status, 402);
  assert.equal(paymentCalls, 0);
});

test("a failed capability lookup cannot produce a quote or discovery advertisement", async () => {
  for (const path of ["/.well-known/x402", "/api/v1/export/chain-events"]) {
    resetModuleState();
    const response = await withFetch(
      (async () => Response.json({ kinds: [] })) as typeof fetch,
      () =>
        handleRequest(new Request(`https://api.metagraph.sh${path}`), paid()),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("payment-required"), null);
  }
});

test("an unavailable migration or D1 session never advertises mainnet payment", async () => {
  for (const db of [
    {
      prepare() {
        throw new Error("missing table");
      },
    },
    {
      withSession() {
        throw new Error("session unavailable");
      },
    },
  ]) {
    const env = mockEnv({
      X402_PAY_TO: PAY_TO,
      D1_STATE_TABLES: " x402_payment_attempts ",
      D1_STATE: db,
    });
    for (const path of ["/.well-known/x402", "/api/v1/export/chain-events"]) {
      const response = await handleRequest(
        new Request(`https://api.metagraph.sh${path}`),
        env,
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("payment-required"), null);
    }
  }
});

test("a lost post-submit response tells the browser to retry its original payment", async () => {
  const delegate = facilitator({ isValid: true }, {});
  const response = await withFetch(
    (async (url, init) => {
      if (String(url).endsWith("/settle"))
        throw new Error("reply lost after broadcast");
      return delegate(url, init);
    }) as typeof fetch,
    () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), paid()),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal(response.headers.get("payment-response"), null);
  const body = await jsonBody(response);
  assert.equal(body.error.code, "x402_settlement_pending");
  assert.equal(body.meta.retry, "same_payment_payload");
});

test("an unsupported selected offer is refused with the current canonical quote", async () => {
  const selected = JSON.parse(atob(payment));
  selected.accepted.network = "eip155:999";
  const response = await withFetch(facilitator({}, {}), () =>
    handleRequest(
      ask({ [X402_SIGNATURE_HEADER]: btoa(JSON.stringify(selected)) }),
      paid(),
    ),
  );
  assert.equal(response.status, 402);
  const body = await jsonBody(response);
  assert.match(body.resource.description, /does not match/);
  assert.equal(body.accepts[0].network, "eip155:8453");
});

test("an intentionally unconfigured payment rail refuses explicit payment without settling", async () => {
  let calls = 0;
  const response = await withFetch(
    (async () => {
      calls++;
      throw new Error("settlement disabled");
    }) as typeof fetch,
    () => handleRequest(ask({ [X402_SIGNATURE_HEADER]: payment }), mockEnv({})),
  );
  assert.equal(response.status, 503);
  assert.equal((await jsonBody(response)).error.code, "x402_unavailable");
  assert.equal(response.headers.get("payment-required"), null);
  assert.equal(calls, 0);
});

test("an empty payment header retains ordinary anonymous access", async () => {
  const response = await handleRequest(
    ask({ [X402_SIGNATURE_HEADER]: "" }),
    mockEnv({ X402_PAY_TO: PAY_TO }),
  );
  assert.notEqual(response.status, 402);
  assert.notEqual(
    response.headers.get("x-metagraph-error-code"),
    "x402_unavailable",
  );
});
