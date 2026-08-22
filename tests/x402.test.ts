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
  X402_DEFAULT_SOLANA_NETWORK,
  X402_NETWORKS,
  X402_PAID_FAMILIES,
  X402_SIGNATURE_HEADER,
  X402_VERSION,
  isEvmAddress,
  isSolanaAddress,
  paymentRequiredResponse,
  paymentRequirements,
  resolveX402Config,
  verifyAndSettle,
  x402Manifest,
  x402PriceFor,
} from "../src/x402.ts";
import type { Row } from "./row-type.ts";

const PAY_TO = "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f";
const PAY_TO_SOL = "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87";
/** EVM only, which is what most of these assertions are about. */
const env = (over: Row = {}) =>
  ({ X402_PAY_TO: PAY_TO, ...over }) as unknown as Env;
/** Both legs, as production is configured. */
const bothEnv = (over: Row = {}) =>
  ({
    X402_PAY_TO: PAY_TO,
    X402_PAY_TO_SOLANA: PAY_TO_SOL,
    ...over,
  }) as unknown as Env;

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
    assert.equal(config.legs.length, 1);
    assert.equal(config.legs[0]!.network, X402_DEFAULT_NETWORK);
    assert.equal(config.legs[0]!.network, "eip155:84532");
    assert.equal(config.legs[0]!.asset, X402_NETWORKS["eip155:84532"]!.asset);
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

describe("isSolanaAddress", () => {
  test("accepts a base58 address", () => {
    assert.equal(isSolanaAddress(PAY_TO_SOL), true);
  });

  test("rejects the base58 lookalike characters", () => {
    // 0, O, I and l are excluded from the alphabet precisely because they are
    // the transcription errors people actually make.
    for (const bad of ["0" + PAY_TO_SOL.slice(1), PAY_TO_SOL.slice(1) + "O"]) {
      assert.equal(isSolanaAddress(bad), false, bad);
    }
  });

  test("rejects anything that is not one", () => {
    for (const value of [undefined, null, 42, "", "short", PAY_TO]) {
      assert.equal(isSolanaAddress(value), false, String(value));
    }
  });
});

describe("the two legs do not contaminate each other", () => {
  test("an EVM address on a Solana network yields NO leg", () => {
    // Both halves well-formed, the pair meaningless: a 0x address cannot
    // receive on Solana. Without the kind check this would quote a recipient
    // that cannot exist on the chain being quoted.
    const config = resolveX402Config(env({ X402_PAY_TO_SOLANA: PAY_TO }));
    assert.equal(config!.legs.length, 1);
    assert.equal(config!.legs[0]!.network, X402_DEFAULT_NETWORK);
  });

  test("a Solana address on an EVM network yields NO leg", () => {
    assert.equal(
      resolveX402Config({ X402_PAY_TO: PAY_TO_SOL } as unknown as Env),
      null,
    );
  });

  test("a broken EVM leg does not take the Solana leg down", () => {
    const config = resolveX402Config(
      bothEnv({ X402_PAY_TO: "not-an-address" }),
    )!;
    assert.equal(config.legs.length, 1);
    assert.equal(config.legs[0]!.payTo, PAY_TO_SOL);
  });

  test("null only when NO leg resolves", () => {
    assert.equal(resolveX402Config({} as unknown as Env), null);
  });

  test("a leg pointed at the OTHER chain's network yields no leg", () => {
    // The kind check, distinct from the address check above: here the address
    // is right for its leg and the NETWORK is wrong. Naming an EVM network as
    // the Solana one would otherwise quote a base58 recipient on Base.
    assert.equal(
      resolveX402Config(bothEnv({ X402_NETWORK_SOLANA: "eip155:84532" }))!.legs
        .length,
      1,
    );
    assert.equal(
      resolveX402Config({
        X402_PAY_TO: PAY_TO,
        X402_NETWORK: X402_DEFAULT_SOLANA_NETWORK,
      } as unknown as Env),
      null,
    );
  });
});

describe("the Solana leg's quote", () => {
  const config = resolveX402Config(bothEnv())!;

  test("carries the sponsoring feePayer, which SVM exact requires", () => {
    // Without it the payer cannot build the transaction: SVM exact is
    // fee-sponsored so the payer needs no SOL, and the sponsor's address is
    // part of the quote.
    const svm = paymentRequirements(config, "10000").find((r) =>
      r.network.startsWith("solana:"),
    )!;
    assert.ok(svm.extra.feePayer, "feePayer must be quoted");
    assert.equal(svm.asset, X402_NETWORKS[X402_DEFAULT_SOLANA_NETWORK]!.asset);
  });

  test("quotes the SAME price as the EVM leg", () => {
    // USDC is six decimals on both chains -- the mint was checked, not
    // assumed -- so one atomic amount is one price. Two legs quoting
    // different money for the same call would be a bug nobody notices.
    const amounts = new Set(
      paymentRequirements(config, "10000").map((r) => r.amount),
    );
    assert.deepEqual([...amounts], ["10000"]);
  });

  test("the EVM leg keeps its EIP-712 domain, not the SVM extra", () => {
    const evm = paymentRequirements(config, "10000").find((r) =>
      r.network.startsWith("eip155:"),
    )!;
    assert.equal(evm.extra.name, "USDC");
    assert.equal(evm.extra.feePayer, undefined);
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
    const byNetwork = new Map(config!.legs.map((l) => [l.network, l]));
    assert.equal(
      byNetwork.get(String(vars.X402_NETWORK))?.payTo,
      vars.X402_PAY_TO,
    );
    assert.equal(
      byNetwork.get(X402_DEFAULT_SOLANA_NETWORK)?.payTo,
      vars.X402_PAY_TO_SOLANA,
      "the Solana leg is the one that takes real money -- it must resolve",
    );
  });
});

describe("verifyAndSettle picks the leg the payer chose", () => {
  const both = resolveX402Config(bothEnv())!;
  const offered = paymentRequirements(both, "10000");

  /** Captures what the facilitator was asked to verify. */
  function capturing(seen: Row[]) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/verify")) {
        seen.push(JSON.parse(String(init?.body)) as Row);
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  test("verifies a Solana payment against the SOLANA requirements", async () => {
    // The bug this exists for: verifying a Solana payment against Base
    // requirements compares an amount to the wrong asset on the wrong chain,
    // and the facilitator would be answering a question nobody asked.
    const seen: Row[] = [];
    const verdict = await verifyAndSettle(
      both,
      signed({ network: X402_DEFAULT_SOLANA_NETWORK }),
      offered,
      capturing(seen),
    );
    assert.equal(verdict.outcome, "settled");
    const asked = seen[0]!.paymentRequirements as Row;
    assert.equal(asked.network, X402_DEFAULT_SOLANA_NETWORK);
    assert.equal(asked.payTo, PAY_TO_SOL);
  });

  test("verifies an EVM payment against the EVM requirements", async () => {
    const seen: Row[] = [];
    await verifyAndSettle(
      both,
      signed({ network: X402_DEFAULT_NETWORK }),
      offered,
      capturing(seen),
    );
    assert.equal((seen[0]!.paymentRequirements as Row).payTo, PAY_TO);
  });

  test("a network we do not accept is rejected, not verified", async () => {
    const seen: Row[] = [];
    const verdict = await verifyAndSettle(
      both,
      signed({ network: "eip155:1" }),
      offered,
      capturing(seen),
    );
    assert.equal(verdict.outcome, "rejected");
    assert.equal(seen.length, 0, "the facilitator must not be asked");
  });

  test("a payload that is not an object at all is rejected", async () => {
    // `btoa("\"hello\"")` decodes to a valid JSON string, so it clears the
    // malformed check and still has no network to match.
    for (const payload of ["a string", 42, null]) {
      const verdict = await verifyAndSettle(
        both,
        signed(payload),
        offered,
        capturing([]),
      );
      assert.equal(verdict.outcome, "rejected", JSON.stringify(payload));
    }
  });

  test("a payload naming no network is rejected when several are offered", async () => {
    // There is no safe guess here. Picking one would verify a signature
    // against requirements the payer never agreed to.
    const verdict = await verifyAndSettle(
      both,
      signed({}),
      offered,
      capturing([]),
    );
    assert.equal(verdict.outcome, "rejected");
  });

  test("but a SINGLE offered leg is used as-is, with no network field", async () => {
    // Backward compatibility, and stated: before there were two legs a client
    // never had to send `network`. Matching strictly would turn a
    // previously-working client into a rejection for a field it never sent.
    const seen: Row[] = [];
    const one = resolveX402Config(env())!;
    const verdict = await verifyAndSettle(
      one,
      signed({}),
      paymentRequirements(one, "10000"),
      capturing(seen),
    );
    assert.equal(verdict.outcome, "settled");
    assert.equal((seen[0]!.paymentRequirements as Row).network, "eip155:84532");
  });
});

describe("x402Manifest", () => {
  test("is null when unconfigured, so payability is never advertised falsely", () => {
    assert.equal(x402Manifest(null, "https://api.metagraph.sh"), null);
  });

  test("names every network's own address, and what a payment buys", () => {
    // One entry per leg. A reader deciding whether they can pay us needs the
    // address in THEIR chain's format; a single payTo answers that for one
    // audience and misleads the other.
    const manifest = x402Manifest(
      resolveX402Config(bothEnv()),
      "https://api.metagraph.sh",
    )!;
    const accepts = manifest.accepts as Row[];
    const byNetwork = new Map(accepts.map((a) => [String(a.network), a]));
    assert.equal(byNetwork.get(X402_DEFAULT_NETWORK)?.payTo, PAY_TO);
    assert.equal(byNetwork.get(X402_DEFAULT_SOLANA_NETWORK)?.payTo, PAY_TO_SOL);
    assert.equal(accepts.length, 2);
    assert.equal(
      (manifest.resources as Row[]).length,
      X402_PAID_FAMILIES.length,
    );
    // Points at what is free, so a reader can tell what they are NOT paying for.
    assert.match(String(manifest.free), /auth\.md$/);
  });
});
