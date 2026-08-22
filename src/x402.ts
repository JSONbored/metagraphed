// Per-call machine payments over HTTP 402 (x402 v2), for the REST surface.
//
// ## WHY REST AND NOT /mcp
//
// Recorded in metagraphed-infra#629 and unchanged: Claude's MCP client cannot
// act on a `402` -- there is no payment UI, so the response is just an error --
// and the Connectors Directory excludes connectors that "transfer money,
// cryptocurrency, or other financial assets". Putting a payment rail on the
// tool surface would risk the listing to serve an audience that is not there.
//
// Two rails, two audiences: OAuth + a `401` challenge + tiers for humans in
// Claude; x402 on REST for autonomous agents that hold a wallet.
//
// ## THE INVARIANT: A PAYMENT NEVER GATES A CALL THAT WOULD HAVE SUCCEEDED
//
// x402 here is ADDITIVE. It never turns a would-be-200 into a 402. It is a way
// to buy, without a signup, the same headroom an API key buys -- and nothing
// more. A caller who presents no payment is served exactly as they are today.
//
// The alternative was drafted and abandoned for a concrete reason: gating the
// `ai` family outright would have broken our own website, which calls
// `/api/v1/ask` ANONYMOUSLY from the Ask feature and the command palette with
// `headers: { Accept: "application/json" }` and no credential. A paywall that
// breaks the product it monetises is not a paywall -- and the browser cannot
// hold a key to get around it, because a key shipped in client JS is public.
//
// It is also what ADR 0027 and #11179 already decided: public by default,
// authentication buys throughput, and a tier gates depth, freshness and rate --
// never visibility. A per-call payment is one more way to clear the same bars,
// not a new bar in front of everyone.
//
// ## WHY IT IS INERT WITHOUT CONFIGURATION
//
// `resolveX402Config` returns null unless a payTo address is set, and every
// caller treats null as "this deployment does not take payments" -- no `402`
// is ever emitted and the routes behave exactly as they do today. That is what
// lets the config and the deploy land in either order with no window where a
// caller is charged for something we cannot settle, and no window where we
// advertise payability we do not have (the same dishonesty #11175 refused for
// an A2A card with no endpoint behind it).
//
// ## THE WIRE FORMAT IS v2, WHICH IS NOT v1 WITH A BUMP
//
// Verified against specs/x402-specification-v2.md and
// specs/transports-v2/http.md rather than inferred:
//
//   * the requirement field is `amount`, not v1's `maxAmountRequired`;
//   * networks are CAIP-2 ids (`eip155:84532`), not bare names;
//   * three headers carry the exchange -- `PAYMENT-REQUIRED` (server asks),
//     `PAYMENT-SIGNATURE` (client answers), `PAYMENT-RESPONSE` (server
//     settles) -- each a base64-encoded JSON document. v1's `X-PAYMENT` is
//     gone, and using it would be silently non-interoperable with every real
//     client, which is exactly the class of bug that passes its own tests.

import { routeCost } from "./route-cost-weights.ts";

/**
 * Server -> client, alongside the 402 body.
 *
 * Module-private, unlike its two siblings: only `paymentRequiredResponse` sets
 * it, and tests/x402.test.ts asserts the WIRE name as a literal rather than
 * importing this. That is deliberate -- an assertion that reads the same
 * constant the code writes proves only that the file is self-consistent, which
 * is the one thing that was never in doubt.
 */
const X402_REQUIRED_HEADER = "payment-required";
/** Client -> server, carrying the signed payload. */
export const X402_SIGNATURE_HEADER = "payment-signature";
/** Server -> client, carrying the settlement result. */
export const X402_RESPONSE_HEADER = "payment-response";

export const X402_VERSION = 2;

/**
 * The networks this build knows, with the USDC contract on each.
 *
 * A CLOSED SET on purpose. The asset address is what a payer's funds move to,
 * so it must never be assembled from configuration a typo can reach: naming a
 * network selects a contract this table states, or the config resolves to null
 * and the deployment takes no payments at all.
 *
 * ## KNOWING A NETWORK IS NOT BEING ABLE TO SETTLE ON IT
 *
 * The facilitator settles, and it has its own list. Measured against
 * `GET https://x402.org/facilitator/supported` on 2026-08-22, the public
 * facilitator answers for:
 *
 *   eip155:84532                                  Base SEPOLIA
 *   solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1       Solana MAINNET
 *   algorand / aptos / stellar:testnet / hedera:testnet / xrpl
 *
 * `eip155:8453` -- Base MAINNET -- IS NOT ON THAT LIST. Setting X402_NETWORK to
 * it would quote a price in a currency this deployment cannot collect: verify
 * rejects the unsupported network, the gate fails closed (correctly), and every
 * caller who tries to pay gets a 402 instead of their answer. Nothing would log
 * an error, because refusing an unverifiable payment is exactly what the gate
 * is for.
 *
 * So Base mainnet needs a different facilitator (Coinbase's CDP one, which
 * wants CDP API credentials) before it can be selected. Real money on the
 * public facilitator means SOLANA mainnet, not Base.
 */
export const X402_NETWORKS: Readonly<
  Record<string, { readonly asset: string; readonly label: string }>
> = {
  "eip155:84532": {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    label: "Base Sepolia",
  },
  "eip155:8453": {
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    label: "Base",
  },
};

/** Testnet, deliberately. A first settlement bug should cost test funds. */
export const X402_DEFAULT_NETWORK = "eip155:84532";

/** The public facilitator Coinbase operates, and what Cloudflare's own
 * examples use. Overridable, because the counterparty is a real choice. */
export const X402_DEFAULT_FACILITATOR = "https://x402.org/facilitator";

/**
 * How long a payer has to complete an authorization, in seconds.
 *
 * Short: the quote embeds a price for a specific call, and a stale
 * authorization is one where the work may already have been served.
 */
export const X402_MAX_TIMEOUT_SECONDS = 60;

/**
 * Atomic USDC units per unit of route cost weight.
 *
 * DERIVED FROM THE EXISTING COST MODEL rather than picked per route. USDC has
 * six decimals, so 400 atomic units is $0.0004. Against
 * src/route-cost-weights.ts that puts an `ask` call (weight 25) at $0.01 and a
 * deep-history read (weight 5) at $0.002 -- both inside the observed market
 * band ($0.002-0.01 for data calls, $0.01-0.05 for LLM-backed ones), and
 * neither invented.
 *
 * The point of deriving it: a route whose cost weight changes because the work
 * changed gets a price that follows, instead of a number that silently stops
 * describing what it charges for.
 */
export const X402_ATOMIC_UNITS_PER_COST_WEIGHT = 400;

export interface X402Config {
  /** Where funds go. */
  readonly payTo: string;
  /** CAIP-2 id. */
  readonly network: string;
  /** USDC contract on that network. */
  readonly asset: string;
  readonly networkLabel: string;
  readonly facilitatorUrl: string;
}

/** A 0x-prefixed, 20-byte address.
 *
 * Format only. EIP-55 checksum validation needs keccak256, which Node does not
 * ship (`sha3-256` is NIST SHA-3, a different padding) and which is not in this
 * repo's dependencies -- so a mixed-case address that is well-formed but
 * mistyped would pass here. That is why payTo lives in version control rather
 * than in a mutable secret: the value a payer's funds move to should not be
 * changeable without a reviewable diff. */
export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * The payment configuration for this deployment, or null.
 *
 * Null on ANY incomplete or unrecognised input -- no payTo, a malformed
 * address, a network this build has no asset for. Never a partial config: a
 * `402` quoting an address we cannot be sure of is worse than not charging.
 */
export function resolveX402Config(env: Env | undefined): X402Config | null {
  const payTo = env?.X402_PAY_TO;
  if (!isEvmAddress(payTo)) return null;
  const network = env?.X402_NETWORK || X402_DEFAULT_NETWORK;
  // Own-property lookup: `network` is configuration, and a value of
  // "constructor" or "toString" would otherwise resolve to an inherited Object
  // member and read as a configured network -- the same class of bypass
  // applyTieredRateLimit guards against for tier names.
  if (!Object.hasOwn(X402_NETWORKS, network)) return null;
  const entry = X402_NETWORKS[network]!;
  return {
    payTo,
    network,
    asset: entry.asset,
    networkLabel: entry.label,
    facilitatorUrl: env?.X402_FACILITATOR_URL || X402_DEFAULT_FACILITATOR,
  };
}

/**
 * The route families a payment can buy headroom on, and nothing else.
 *
 * Being on this list does NOT make a route paid -- see the invariant in this
 * module's header. It makes a route one where a caller MAY present a payment
 * to be treated as keyed rather than anonymous.
 *
 * An allowlist rather than a cost-weight threshold, because "expensive" and
 * "worth offering headroom on" are different questions.
 */
export const X402_PAID_FAMILIES: readonly string[] = ["ai", "deep-history"];

/** Can a payment buy headroom here, and what does one call cost in atomic
 * units? Null means presenting one buys nothing, so none is ever quoted. */
export function x402PriceFor(pathname: string): {
  family: string;
  atomicAmount: string;
} | null {
  const { family, weight } = routeCost(pathname);
  if (!X402_PAID_FAMILIES.includes(family)) return null;
  return {
    family,
    atomicAmount: String(weight * X402_ATOMIC_UNITS_PER_COST_WEIGHT),
  };
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: "USDC"; version: "2" };
}

/** The requirement a payer must satisfy for one call. */
export function paymentRequirements(
  config: X402Config,
  atomicAmount: string,
): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    amount: atomicAmount,
    asset: config.asset,
    payTo: config.payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: { name: "USDC", version: "2" },
  };
}

function base64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64Json(value: string): unknown {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * The 402 a caller gets when they have not paid.
 *
 * Carries the requirement in BOTH the body and the `PAYMENT-REQUIRED` header,
 * which is what the v2 HTTP transport specifies -- a client may read either,
 * and a server that populates only one works with half the clients.
 *
 * `error` is a sentence rather than a code because a human reads it when an
 * agent relays a failure upward, and "payment required" with no price is the
 * least actionable thing a paywall can say.
 */
export function paymentRequiredResponse(
  config: X402Config,
  request: Request,
  atomicAmount: string,
  description: string,
): Response {
  const requirements = paymentRequirements(config, atomicAmount);
  const body = {
    x402Version: X402_VERSION,
    error: `Payment required: ${atomicAmount} atomic USDC on ${config.networkLabel}.`,
    resource: {
      url: request.url,
      description,
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {},
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [X402_REQUIRED_HEADER]: base64Json(body),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export type X402Verdict =
  /** No payment presented. NOT a refusal -- the caller proceeds as anonymous. */
  | { readonly outcome: "unpaid" }
  | { readonly outcome: "malformed"; readonly reason: string }
  | { readonly outcome: "rejected"; readonly reason: string }
  | {
      readonly outcome: "settled";
      readonly responseHeader: string;
      /** The paying address. x402 treats the wallet as the identity, so this is
       * what the headroom a payment buys is keyed to. */
      readonly payer: string;
    };

/**
 * Verify and settle a presented payment.
 *
 * ## VERIFY THEN SETTLE, BOTH BEFORE THE WORK
 *
 * The alternative -- serve, then settle -- loses the money on any failure
 * after the response is committed, and a Worker cannot retract a stream it has
 * begun. So both facilitator calls happen first, and the caller only does the
 * work once `settled` comes back.
 *
 * ## A FACILITATOR THAT CANNOT ANSWER IS NOT A PAYMENT
 *
 * Every failure path is a refusal, never a pass. This is the one control in
 * this repo that must fail CLOSED: the rate limiter fails open because a
 * throttle outage should not deny a paying caller, but a payment outage that
 * failed open would serve paid work for free to anyone who noticed. The
 * asymmetry is deliberate and is why this does not follow the house pattern.
 */
export async function verifyAndSettle(
  config: X402Config,
  request: Request,
  requirements: PaymentRequirements,
  fetchImpl: typeof fetch = fetch,
): Promise<X402Verdict> {
  const header = request.headers.get(X402_SIGNATURE_HEADER);
  if (!header) return { outcome: "unpaid" };

  let paymentPayload: unknown;
  try {
    paymentPayload = decodeBase64Json(header);
  } catch {
    return {
      outcome: "malformed",
      reason: `${X402_SIGNATURE_HEADER} must be base64-encoded JSON.`,
    };
  }

  const envelope = {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: requirements,
  };

  const verified = await facilitatorCall(
    config,
    "/verify",
    envelope,
    fetchImpl,
  );
  if (!verified || verified.isValid !== true) {
    return {
      outcome: "rejected",
      reason:
        typeof verified?.invalidReason === "string"
          ? verified.invalidReason
          : "the facilitator could not verify this payment",
    };
  }

  const settled = await facilitatorCall(config, "/settle", envelope, fetchImpl);
  if (!settled || settled.success !== true) {
    return {
      outcome: "rejected",
      reason:
        typeof settled?.errorReason === "string"
          ? settled.errorReason
          : "the facilitator could not settle this payment",
    };
  }
  return {
    outcome: "settled",
    responseHeader: base64Json(settled),
    // The facilitator names the payer; falling back to the verify step's
    // answer covers a settle response that omits it. Empty is possible and is
    // handled by the caller -- an unattributable payment still settled, it
    // simply cannot be given its own budget.
    payer:
      typeof settled.payer === "string"
        ? settled.payer
        : typeof verified.payer === "string"
          ? verified.payer
          : "",
  };
}

async function facilitatorCall(
  config: X402Config,
  path: "/verify" | "/settle",
  envelope: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`${config.facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Fails CLOSED -- see verifyAndSettle's header for why this one control
    // does not follow the house fail-open pattern.
    return null;
  }
}

/**
 * The discovery document at `/.well-known/x402`, or null when unconfigured.
 *
 * The extensionless path is the one to serve: over 14 days, crawlers fetched
 * `/.well-known/x402` 41 times across AgenstryBot and agent-tools.cloud, and
 * `/.well-known/x402.json` 18 -- both try the extensionless form first.
 *
 * Null when unconfigured, so this is never a manifest advertising payability
 * the deployment cannot honour.
 */
export function x402Manifest(
  config: X402Config | null,
  origin: string,
): Record<string, unknown> | null {
  if (!config) return null;
  return {
    x402Version: X402_VERSION,
    payTo: config.payTo,
    network: config.network,
    asset: config.asset,
    facilitator: config.facilitatorUrl,
    resources: X402_PAID_FAMILIES.map((family) => ({
      family,
      description:
        family === "ai"
          ? "Grounded natural-language answers and semantic search over the registry."
          : "Chain history beyond the free window.",
    })),
    free: `${origin}/auth.md`,
  };
}
