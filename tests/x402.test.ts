// infra#629: per-call machine payments over HTTP 402.
//
// The invariant these tests exist to hold: **a payment never gates a call that
// would have succeeded**. x402 here buys the headroom an API key buys, without
// a signup. It does not put a paywall in front of anyone.
//
// That is not a stylistic preference. Our own website calls `/api/v1/ask`
// anonymously, from the Ask feature and the command palette, with no
// credential -- and a browser cannot hold one, because a key in client JS is
// public. A blanket gate on the `ai` family would have broken the product it
// was meant to monetise.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripJsonComments } from "../scripts/lib.ts";
import { describe, test } from "vitest";
import {
  X402_ATOMIC_UNITS_PER_COST_WEIGHT,
  X402_DEFAULT_NETWORK,
  X402_NETWORKS,
  X402_PAID_FAMILIES,
  X402_SIGNATURE_HEADER,
  X402_VERSION,
  isEvmAddress,
  paymentRequiredResponse,
  paymentRequirements,
  resolveX402Config,
  verifyAndSettle,
  x402Manifest,
  x402PriceFor,
} from "../src/x402.ts";
import type { Row } from "./row-type.ts";

const PAY_TO = "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f";
const env = (over: Row = {}) =>
  ({ X402_PAY_TO: PAY_TO, ...over }) as unknown as Env;

const req = (url = "https://api.metagraph.sh/api/v1/ask", headers: Row = {}) =>
  new Request(url, { headers: headers as Record<string, string> });

/** A payment the facilitator will be asked about. */
const signed = (payload: unknown) =>
  req("https://api.metagraph.sh/api/v1/ask", {
    [X402_SIGNATURE_HEADER]: btoa(JSON.stringify(payload)),
  });

function facilitator(verify: Row, settle: Row, ok = true) {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    const body = href.endsWith("/verify") ? verify : settle;
    return new Response(JSON.stringify(body), { status: ok ? 200 : 500 });
  }) as unknown as typeof fetch;
}

describe("isEvmAddress", () => {
  test("accepts a 20-byte hex address in either case", () => {
    assert.equal(isEvmAddress(PAY_TO), true);
    assert.equal(isEvmAddress(PAY_TO.toLowerCase()), true);
  });

  test("rejects anything that is not one", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "0x",
      PAY_TO.slice(0, -1),
      `${PAY_TO}0`,
      PAY_TO.replace("0x", ""),
      "0xZZ4809C91CF942d00ef04b23f7BaB87d5DA5013f",
    ]) {
      assert.equal(isEvmAddress(value), false, String(value));
    }
  });
});

describe("resolveX402Config", () => {
  test("defaults to Base Sepolia, so a first settlement bug costs test funds", () => {
    const config = resolveX402Config(env())!;
    assert.equal(config.network, X402_DEFAULT_NETWORK);
    assert.equal(config.network, "eip155:84532");
    assert.equal(config.asset, X402_NETWORKS["eip155:84532"]!.asset);
  });

  test("is null on ANY incomplete or unrecognised input", () => {
    // Never a partial config: a 402 quoting an address we cannot be sure of is
    // worse than not charging at all.
    for (const over of [
      { X402_PAY_TO: undefined },
      { X402_PAY_TO: "" },
      { X402_PAY_TO: "not-an-address" },
      { X402_NETWORK: "eip155:1" },
      { X402_NETWORK: "solana:mainnet" },
    ]) {
      assert.equal(resolveX402Config(env(over)), null, JSON.stringify(over));
    }
    assert.equal(resolveX402Config(undefined), null);
  });

  test("a prototype key is not a configured network", () => {
    // `network` is configuration; an inherited Object member reading as a
    // network is the bypass applyTieredRateLimit guards against for tiers.
    for (const network of ["constructor", "toString", "__proto__"]) {
      assert.equal(resolveX402Config(env({ X402_NETWORK: network })), null);
    }
  });
});

describe("x402PriceFor", () => {
  test("prices from the cost model rather than a per-route literal", () => {
    // ai weighs 25, deep-history 5 (src/route-cost-weights.ts). Deriving means
    // a route whose cost changes gets a price that follows.
    assert.deepEqual(x402PriceFor("/api/v1/ask"), {
      family: "ai",
      atomicAmount: String(25 * X402_ATOMIC_UNITS_PER_COST_WEIGHT),
    });
    assert.equal(x402PriceFor("/api/v1/ask")!.atomicAmount, "10000"); // $0.01
    assert.equal(x402PriceFor("/api/v1/blocks")!.atomicAmount, "2000"); // $0.002
  });

  test("is null for everything outside the allowlist", () => {
    // The registry, discovery and health reads are the adoption funnel. Some
    // are not cheap; none are chargeable.
    for (const path of ["/api/v1/subnets", "/api/v1/health", "/llms.txt"]) {
      assert.equal(x402PriceFor(path), null, path);
    }
  });

  test("every allowlisted family actually prices", () => {
    // A family listed but unpriced would quote "0", which is not a payment.
    assert.ok(X402_PAID_FAMILIES.length > 0);
    for (const path of ["/api/v1/ask", "/api/v1/blocks"]) {
      const price = x402PriceFor(path)!;
      assert.ok(X402_PAID_FAMILIES.includes(price.family));
      assert.ok(Number(price.atomicAmount) > 0, path);
    }
  });
});

describe("the 402 body is x402 v2, not v1", () => {
  test("uses `amount` and a CAIP-2 network", async () => {
    const config = resolveX402Config(env())!;
    const response = paymentRequiredResponse(config, req(), "10000", "ask");
    assert.equal(response.status, 402);
    const body = (await response.json()) as Row;
    assert.equal(body.x402Version, X402_VERSION);
    const accepts = (body.accepts as Row[])[0]!;
    assert.equal(accepts.amount, "10000");
    // v1's field name. Using it would be silently non-interoperable.
    assert.equal(accepts.maxAmountRequired, undefined);
    assert.match(String(accepts.network), /^eip155:\d+$/);
    assert.equal(accepts.payTo, PAY_TO);
    assert.equal(accepts.scheme, "exact");
  });

  test("carries the requirement in the header as well as the body", () => {
    // The v2 HTTP transport specifies both; a server populating one works with
    // half the clients.
    const config = resolveX402Config(env())!;
    const response = paymentRequiredResponse(config, req(), "10000", "ask");
    const header = response.headers.get("payment-required");
    assert.ok(header, "PAYMENT-REQUIRED must be set");
    const decoded = JSON.parse(atob(header!)) as Row;
    assert.equal(decoded.x402Version, X402_VERSION);
  });

  test("is never cached", () => {
    const config = resolveX402Config(env())!;
    const response = paymentRequiredResponse(config, req(), "10000", "ask");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

describe("verifyAndSettle", () => {
  const config = resolveX402Config(env())!;
  const requirements = paymentRequirements(config, "10000");

  test("no payment presented is NOT a refusal", () => {
    // The invariant. `unpaid` means proceed as anonymous.
    return verifyAndSettle(
      config,
      req(),
      requirements,
      facilitator({}, {}),
    ).then((verdict) => assert.equal(verdict.outcome, "unpaid"));
  });

  test("settles a valid payment and reports the payer", async () => {
    const verdict = await verifyAndSettle(
      config,
      signed({ x402Version: 2 }),
      requirements,
      facilitator(
        { isValid: true, payer: "0xabc" },
        { success: true, payer: "0xabc", transaction: "0xtx" },
      ),
    );
    assert.equal(verdict.outcome, "settled");
    if (verdict.outcome !== "settled") return;
    assert.equal(verdict.payer, "0xabc");
    const receipt = JSON.parse(atob(verdict.responseHeader)) as Row;
    assert.equal(receipt.transaction, "0xtx");
  });

  test("an unreadable header is malformed, not unpaid", async () => {
    const verdict = await verifyAndSettle(
      config,
      req("https://api.metagraph.sh/api/v1/ask", {
        [X402_SIGNATURE_HEADER]: "!!!not-base64!!!",
      }),
      requirements,
      facilitator({}, {}),
    );
    assert.equal(verdict.outcome, "malformed");
  });

  test("FAILS CLOSED on every facilitator failure", async () => {
    // The one control here that must not fail open. The rate limiter fails
    // open so a throttle outage cannot deny a paying caller; a payment outage
    // that failed open would serve paid work free to anyone who noticed.
    const cases: Array<[string, typeof fetch]> = [
      ["verify says invalid", facilitator({ isValid: false }, {})],
      [
        "settle says failed",
        facilitator({ isValid: true }, { success: false }),
      ],
      [
        "facilitator 500s",
        facilitator({ isValid: true }, { success: true }, false),
      ],
      [
        "facilitator throws",
        (async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      ],
    ];
    for (const [label, impl] of cases) {
      const verdict = await verifyAndSettle(
        config,
        signed({ x402Version: 2 }),
        requirements,
        impl,
      );
      assert.equal(verdict.outcome, "rejected", label);
    }
  });

  test("reports the facilitator's OWN reason when it gives one", async () => {
    // A caller who is told "insufficient_funds" can act. One told "could not
    // verify this payment" can only guess, and will retry the same failure.
    const invalid = await verifyAndSettle(
      config,
      signed({}),
      requirements,
      facilitator({ isValid: false, invalidReason: "insufficient_funds" }, {}),
    );
    assert.equal(invalid.outcome, "rejected");
    if (invalid.outcome === "rejected")
      assert.equal(invalid.reason, "insufficient_funds");

    const unsettled = await verifyAndSettle(
      config,
      signed({}),
      requirements,
      facilitator(
        { isValid: true },
        { success: false, errorReason: "nonce_reused" },
      ),
    );
    assert.equal(unsettled.outcome, "rejected");
    if (unsettled.outcome === "rejected")
      assert.equal(unsettled.reason, "nonce_reused");
  });

  test("falls back to the verify step for the payer, then to empty", async () => {
    // The payer keys the paid rate-limit bucket. A settle response that omits
    // it is not a failure -- the money moved -- so the verify step's answer
    // stands in, and an unattributable payment still settles.
    const fromVerify = await verifyAndSettle(
      config,
      signed({}),
      requirements,
      facilitator({ isValid: true, payer: "0xverify" }, { success: true }),
    );
    assert.equal(fromVerify.outcome, "settled");
    if (fromVerify.outcome === "settled")
      assert.equal(fromVerify.payer, "0xverify");

    const nobody = await verifyAndSettle(
      config,
      signed({}),
      requirements,
      facilitator({ isValid: true }, { success: true }),
    );
    assert.equal(nobody.outcome, "settled");
    if (nobody.outcome === "settled") assert.equal(nobody.payer, "");
  });

  test("a non-object facilitator body is no answer at all", async () => {
    // `200 OK` with `"yes"` or `null` in it. Reading `.isValid` off that
    // yields undefined, which must reject rather than pass by absence.
    for (const body of ['"yes"', "null", "42"]) {
      const verdict = await verifyAndSettle(
        config,
        signed({}),
        requirements,
        (async () =>
          new Response(body, { status: 200 })) as unknown as typeof fetch,
      );
      assert.equal(verdict.outcome, "rejected", body);
    }
  });

  test("settle is never called when verify fails", async () => {
    // Money must not move for a payment we could not verify.
    const calls: string[] = [];
    const impl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ isValid: false }), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyAndSettle(config, signed({}), requirements, impl);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /\/verify$/);
  });
});

describe("the DEPLOYED configuration", () => {
  // The unit tests above all build a config from a literal. These read
  // wrangler.jsonc, because that file is what actually moves money -- and the
  // failure mode is silent: an unrecognised network makes resolveX402Config
  // return null, which stops every payment without erroring anywhere.
  // `stripJsonComments`, not a regex: wrangler.jsonc holds route globs ending
  // in `/*` and a cron containing `*/`, which a naive stripper splices
  // together and deletes the config between.
  const vars = JSON.parse(
    stripJsonComments(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ),
  ).vars as Row;

  test("names a network this build knows", () => {
    const network = String(vars.X402_NETWORK);
    assert.ok(
      network in X402_NETWORKS,
      `${network} is not in X402_NETWORKS; payments would silently stop`,
    );
  });

  test("pays out to a well-formed address", () => {
    assert.equal(isEvmAddress(vars.X402_PAY_TO), true);
  });

  test("resolves to a complete config", () => {
    // The end-to-end check: these two vars, read as a Worker reads them,
    // produce a config that can quote a price.
    const config = resolveX402Config(vars as unknown as Env);
    assert.ok(config, "wrangler.jsonc must produce a usable x402 config");
    assert.equal(config!.payTo, vars.X402_PAY_TO);
    assert.equal(config!.network, vars.X402_NETWORK);
  });
});

describe("x402Manifest", () => {
  test("is null when unconfigured, so payability is never advertised falsely", () => {
    assert.equal(x402Manifest(null, "https://api.metagraph.sh"), null);
  });

  test("names the address, network and what a payment buys", () => {
    const manifest = x402Manifest(
      resolveX402Config(env()),
      "https://api.metagraph.sh",
    )!;
    assert.equal(manifest.payTo, PAY_TO);
    assert.equal(manifest.network, X402_DEFAULT_NETWORK);
    assert.equal(
      (manifest.resources as Row[]).length,
      X402_PAID_FAMILIES.length,
    );
    // Points at what is free, so a reader can tell what they are NOT paying for.
    assert.match(String(manifest.free), /auth\.md$/);
  });
});
