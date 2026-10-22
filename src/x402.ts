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

import {
  X402_BROWSER_RESPONSE_HEADERS,
  X402_REQUIRED_HEADER,
  X402_SIGNATURE_HEADER,
} from "./x402-headers.ts";
export { X402_RESPONSE_HEADER, X402_SIGNATURE_HEADER } from "./x402-headers.ts";
import { X402_PAID_FAMILIES } from "./x402-pricing.ts";
export {
  X402_ATOMIC_UNITS_PER_COST_WEIGHT,
  X402_PAID_FAMILIES,
  X402_REQUIRED_FAMILIES,
  x402PriceFor,
  x402RequiresPayment,
} from "./x402-pricing.ts";
import {
  x402PaymentIdentity,
  x402RequestFingerprint,
} from "./x402-identity.ts";
import type { X402AttemptStore, X402Attempt } from "./x402-attempt-store.ts";
import { readBoundedRequestText } from "../workers/http.ts";

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
 * `GET https://x402.org/facilitator/supported` on 2026-10-22, the default
 * public facilitator supports Base Sepolia (`eip155:84532`) and Solana
 * devnet (`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`) for v2 `exact`.
 * Both are test networks, so neither default leg collects real funds.
 *
 * Base mainnet (`eip155:8453`) needs a separately configured facilitator
 * that supports it. Changing only the network would advertise a payment the
 * default facilitator cannot verify or settle.
 */
export const X402_NETWORKS: Readonly<Record<string, X402NetworkEntry>> = {
  "eip155:84532": {
    kind: "evm",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    label: "Base Sepolia",
    // EIP-712 domain for USDC's transferWithAuthorization.
    extra: { name: "USDC", version: "2" },
  },
  "eip155:8453": {
    kind: "evm",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    label: "Base",
    extra: { name: "USD Coin", version: "2" },
  },
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": {
    kind: "svm",
    // Devnet USDC has six decimals, matching the EVM assets above.
    // https://github.com/x402-foundation/x402/blob/a9772e501f237913fecbf324c355f4e876b8c1dd/python/x402/mechanisms/svm/constants.py
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    label: "Solana Devnet",
    extra: {}, // resolved from this facilitator's current /supported response
  },
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": {
    kind: "svm",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    label: "Solana Mainnet",
    extra: {},
  },
};

/** Testnet, deliberately. A first settlement bug should cost test funds. */
export const X402_DEFAULT_NETWORK = "eip155:84532";

/** Solana devnet, matching the default public facilitator's supported chain. */
export const X402_DEFAULT_SOLANA_NETWORK =
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

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

export interface X402NetworkEntry {
  /** Which address format and signing scheme the network uses. */
  readonly kind: "evm" | "svm";
  /** The USDC contract or mint on that network. */
  readonly asset: string;
  readonly label: string;
  /** Scheme-specific fields the payer needs to build the transaction. */
  readonly extra: Readonly<Record<string, string>>;
}

/** One network this deployment will accept payment on. */
export interface X402Leg {
  /** Where funds go, in that network's own address format. */
  readonly payTo: string;
  /** CAIP-2 id. */
  readonly network: string;
  readonly asset: string;
  readonly networkLabel: string;
  readonly extra: Readonly<Record<string, string>>;
}

/**
 * The payment configuration for this deployment.
 *
 * A LIST OF LEGS, not one network. x402 v2's `accepts` is an array precisely
 * so a server can name every method it takes and let the client pick one it
 * can satisfy -- an agent holding only SOL and one holding only Base USDC both
 * pay the same endpoint, from the same quote. Collapsing this to a single
 * network would turn a protocol feature into a deployment choice, and exclude
 * whichever half of the market we did not pick.
 */
export interface X402Config {
  readonly legs: readonly X402Leg[];
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
 * A base58 Solana address.
 *
 * Format only, for the same reason as isEvmAddress: verifying that the bytes
 * decode to a point on the ed25519 curve needs a dependency this module does
 * not carry, and would still not tell us the address is one somebody holds a
 * key for. The base58 alphabet excludes 0, O, I and l, which catches the
 * transcription errors that actually happen.
 *
 * NOTE FOR OPERATORS: a valid address is not the same as a fundable one. SPL
 * tokens land in an Associated Token Account, and a wallet that has never held
 * USDC has none. See the header of resolveX402Config.
 */
export function isSolanaAddress(value: unknown): value is string {
  return (
    typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
  );
}

/**
 * The payment configuration for this deployment, or null.
 *
 * EACH LEG RESOLVES INDEPENDENTLY, and a leg that does not resolve is simply
 * absent. That is the one place this differs from the rest of the module's
 * fail-closed posture, and deliberately: a deployment configured for Solana
 * and misconfigured for Base should still take Solana payments. What must
 * never happen is a leg quoting an address or asset we are unsure of, and that
 * is preserved -- a leg is either fully resolved or not offered.
 *
 * Null only when NO leg resolves, which means this deployment takes no
 * payments at all.
 *
 * ## AN ADDRESS IS NOT AN ABLE-TO-RECEIVE ADDRESS
 *
 * On Solana, SPL tokens land in an Associated Token Account derived from
 * (owner, mint). A wallet that has never held USDC has no such account, and
 * whether a transfer creates one is up to the payer's transaction -- creating
 * it costs rent that somebody has to pay. Configuring a fresh address here is
 * therefore not sufficient to be paid on it; the ATA has to exist. This
 * function cannot check that (it is a chain read, and this runs in the 402
 * path), so it is stated here instead.
 */
export function resolveX402Config(env: Env | undefined): X402Config | null {
  const legs: X402Leg[] = [];

  const evm = resolveLeg(
    env?.X402_PAY_TO,
    env?.X402_NETWORK || X402_DEFAULT_NETWORK,
    "evm",
  );
  if (evm) legs.push(evm);

  const svm =
    env?.X402_SOLANA_ENABLED === "false"
      ? null
      : resolveLeg(
          env?.X402_PAY_TO_SOLANA,
          env?.X402_NETWORK_SOLANA || X402_DEFAULT_SOLANA_NETWORK,
          "svm",
        );
  if (svm) legs.push(svm);

  if (legs.length === 0) return null;
  return {
    legs,
    facilitatorUrl: (
      env?.X402_FACILITATOR_URL || X402_DEFAULT_FACILITATOR
    ).replace(/\/+$/, ""),
  };
}

/**
 * One leg, or null.
 *
 * The `kind` argument is what stops a configuration mix-up from producing a
 * quote nobody can pay: an EVM address paired with a Solana network would be
 * well-formed on both sides and still name a recipient that cannot exist on
 * the chain being quoted.
 */
function resolveLeg(
  payTo: unknown,
  network: string,
  kind: "evm" | "svm",
): X402Leg | null {
  // Own-property lookup: `network` is configuration, and a value of
  // "constructor" or "toString" would otherwise resolve to an inherited Object
  // member and read as a configured network -- the same class of bypass
  // applyTieredRateLimit guards against for tier names.
  if (!Object.hasOwn(X402_NETWORKS, network)) return null;
  const entry = X402_NETWORKS[network]!;
  if (entry.kind !== kind) return null;
  const valid = kind === "evm" ? isEvmAddress(payTo) : isSolanaAddress(payTo);
  if (!valid) return null;
  return {
    payTo: payTo as string,
    network,
    asset: entry.asset,
    networkLabel: entry.label,
    extra: entry.extra,
  };
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Scheme-specific fields, and NOT one shape across networks: EVM carries the
   * EIP-712 domain (`name`/`version`), SVM carries the sponsoring `feePayer`.
   * Pinning this to the EVM shape is what would quietly drop the field a
   * Solana payer needs to build the transaction at all.
   */
  extra: Readonly<Record<string, string>>;
}

/** The requirement a payer must satisfy for one call. */
export function paymentRequirements(
  config: X402Config,
  atomicAmount: string,
): PaymentRequirements[] {
  // Same price on every leg. USDC has six decimals on both Base and Solana
  // (the mint was checked, not assumed), so one atomic amount is one price --
  // no per-network conversion, and no chance of the two legs quoting
  // different money for the same call.
  return config.legs.map((leg) => ({
    scheme: "exact",
    network: leg.network,
    amount: atomicAmount,
    asset: leg.asset,
    payTo: leg.payTo,
    maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
    extra: leg.extra,
  }));
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
    error: `Payment required: ${atomicAmount} atomic USDC on ${config.legs
      .map((leg) => leg.networkLabel)
      .join(" or ")}.`,
    resource: {
      url: request.url,
      description,
      mimeType: "application/json",
    },
    // EVERY leg, so the client picks. This is the array x402 v2 defined it as.
    accepts: requirements,
    extensions: {},
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [X402_REQUIRED_HEADER]: base64Json(body),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": X402_BROWSER_RESPONSE_HEADERS.join(", "),
    },
  });
}

export type X402Verdict =
  | { readonly outcome: "unpaid" }
  | {
      readonly outcome: "malformed" | "rejected" | "unavailable";
      readonly reason: string;
    }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "consumed"; readonly responseHeader: string }
  | { readonly outcome: "pending"; readonly responseHeader?: string }
  | {
      readonly outcome: "settled";
      readonly responseHeader: string;
      readonly payer: string;
    };

type OfferedRequirements =
  | readonly PaymentRequirements[]
  | (() => Promise<readonly PaymentRequirements[] | null>);

/** Verify before binding, bind before settlement, and claim paid work once.
 * Mainnet always requires native durable storage. Existing pending attempts
 * replay their exact original provider/envelope before resolving current offers. */
export async function verifyAndSettle(
  config: X402Config,
  request: Request,
  offered: OfferedRequirements,
  fetchImpl: typeof fetch = fetch,
  attemptStore?: X402AttemptStore | null,
): Promise<X402Verdict> {
  const header = request.headers.get(X402_SIGNATURE_HEADER);
  if (!header) return { outcome: "unpaid" };
  let paymentPayload: unknown;
  try {
    if (header.length > 32_768) throw new Error("Payment header is too large");
    paymentPayload = decodeBase64Json(header);
  } catch {
    return {
      outcome: "malformed",
      reason: `${X402_SIGNATURE_HEADER} must be bounded base64-encoded JSON.`,
    };
  }

  const guarded =
    attemptStore !== undefined ||
    config.legs.some(
      (leg) =>
        leg.network === "eip155:8453" ||
        leg.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    );
  let identityKey = "";
  let requestFingerprint = "";
  if (guarded) {
    const identity = await x402PaymentIdentity(paymentPayload);
    const fingerprint = await x402RequestFingerprint(request);
    if (!identity || !fingerprint)
      return {
        outcome: "malformed",
        reason:
          "The v2 payment must identify a signed transfer and a bounded request.",
      };
    identityKey = identity;
    requestFingerprint = fingerprint;
    if (!attemptStore) return unavailable();
    try {
      const existing = await attemptStore.get(identityKey);
      if (existing)
        return resumeAttempt(
          existing,
          requestFingerprint,
          attemptStore,
          fetchImpl,
        );
    } catch {
      return unavailable();
    }
  }

  let requirements: PaymentRequirements | null;
  try {
    const current = typeof offered === "function" ? await offered() : offered;
    if (!current) return unavailable();
    requirements = selectRequirements(current, paymentPayload);
  } catch {
    return unavailable();
  }
  if (!requirements)
    return {
      outcome: "rejected",
      reason:
        "the payment does not match an advertised requirement; see the accepts list on the 402",
    };
  const envelope = JSON.stringify({
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements: requirements,
  });
  const verified = await facilitatorCall(
    config.facilitatorUrl,
    "/verify",
    envelope,
    fetchImpl,
  );
  if (
    !verified ||
    (!verified.ok && (verified.status === 429 || verified.status >= 500))
  )
    return unavailable();
  if (!verified.ok || verified.body.isValid !== true)
    return {
      outcome: "rejected",
      reason:
        typeof verified.body.invalidReason === "string"
          ? verified.body.invalidReason
          : "the facilitator could not verify this payment",
    };
  const payer =
    typeof verified.body.payer === "string" ? verified.body.payer : "";
  if (attemptStore) {
    try {
      const bound = await attemptStore.bind({
        identityKey,
        requestFingerprint,
        facilitatorUrl: config.facilitatorUrl,
        envelope,
        payer,
      });
      return await resumeAttempt(
        bound,
        requestFingerprint,
        attemptStore,
        fetchImpl,
      );
    } catch {
      return unavailable();
    }
  }
  return settleEnvelope(config.facilitatorUrl, envelope, payer, fetchImpl);
}

function unavailable(): X402Verdict {
  return {
    outcome: "unavailable",
    reason:
      "Payment processing is temporarily unavailable. Retry the identical request and payment payload.",
  };
}

async function resumeAttempt(
  attempt: X402Attempt,
  requestFingerprint: string,
  store: X402AttemptStore,
  fetchImpl: typeof fetch,
): Promise<X402Verdict> {
  if (attempt.requestFingerprint !== requestFingerprint)
    return { outcome: "conflict" };
  if (attempt.state === "consumed")
    return { outcome: "consumed", responseHeader: attempt.receipt! };
  if (!attempt.envelope) return unavailable();
  const verdict = await settleEnvelope(
    attempt.facilitatorUrl,
    attempt.envelope,
    attempt.payer,
    fetchImpl,
  );
  if (verdict.outcome !== "settled") return verdict;
  try {
    const claimed = await store.consume(
      attempt.identityKey,
      requestFingerprint,
      verdict.responseHeader,
    );
    if (claimed) return verdict;
    const winner = await store.get(attempt.identityKey);
    if (winner?.state === "consumed")
      return { outcome: "consumed", responseHeader: winner.receipt! };
  } catch {
    // Settlement may already have broadcast. Never create a fresh challenge.
  }
  return { outcome: "pending", responseHeader: verdict.responseHeader };
}

async function settleEnvelope(
  facilitatorUrl: string,
  envelope: string,
  payer: string,
  fetchImpl: typeof fetch,
): Promise<X402Verdict> {
  const settled = await facilitatorCall(
    facilitatorUrl,
    "/settle",
    envelope,
    fetchImpl,
  );
  if (!settled) return { outcome: "pending" };
  const responseHeader = base64Json(settled.body);
  if (!settled.ok || settled.body.success !== true)
    return { outcome: "pending", responseHeader };
  return {
    outcome: "settled",
    responseHeader,
    payer: typeof settled.body.payer === "string" ? settled.body.payer : payer,
  };
}

/**
 * The offered requirement the payer's payload targets.
 *
 * v2's `accepted` must match an advertised offer. Earlier clients without that
 * field retain the single-offer and top-level-network behavior; the facilitator
 * still verifies their payload against our own advertised requirements.
 *
 * With several offered there is no such fallback: an unmatched payload is
 * rejected rather than verified against an arbitrary leg.
 */
function selectRequirements(
  offered: readonly PaymentRequirements[],
  payload: unknown,
): PaymentRequirements | null {
  if (payload && typeof payload === "object" && "accepted" in payload) {
    // v2 carries the selected offer under `accepted`, not at the top level.
    // Use only our advertised requirements for the facilitator, and reject
    // changes to the recipient, asset, amount or scheme before asking it.
    const accepted = payload.accepted;
    if (!accepted || typeof accepted !== "object" || Array.isArray(accepted)) {
      return null;
    }
    const choice = accepted as Record<string, unknown>;
    const requirement = offered.find(
      (entry) => entry.network === choice.network,
    );
    if (!requirement) return null;
    for (const field of [
      "scheme",
      "network",
      "amount",
      "asset",
      "payTo",
      "maxTimeoutSeconds",
    ] as const) {
      if (choice[field] !== requirement[field]) return null;
    }
    const extra = choice.extra;
    if (!extra || typeof extra !== "object" || Array.isArray(extra))
      return null;
    const extraFields = extra as Record<string, unknown>;
    if (
      Object.keys(extraFields).length !== Object.keys(requirement.extra).length
    ) {
      return null;
    }
    for (const [name, value] of Object.entries(requirement.extra)) {
      if (extraFields[name] !== value) return null;
    }
    return requirement;
  }
  // Retain the earlier top-level network shape only when no v2 offer was
  // supplied. A malformed or altered `accepted` must never use this fallback.
  if (offered.length === 1) return offered[0]!;
  const network =
    payload && typeof payload === "object"
      ? (payload as { network?: unknown }).network
      : undefined;
  if (typeof network !== "string") return null;
  return offered.find((entry) => entry.network === network) ?? null;
}

async function facilitatorCall(
  facilitatorUrl: string,
  path: "/verify" | "/settle",
  envelope: string,
  fetchImpl: typeof fetch,
): Promise<{
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
} | null> {
  try {
    const response = await fetchImpl(`${facilitatorUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: envelope,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Non-2xx protocol bodies can carry a pending broadcast transaction.
    const body = await readBoundedRequestText(response, 65_536);
    if (!body.ok) return null;
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    return {
      ok: response.ok,
      status: response.status,
      body: parsed as Record<string, unknown>,
    };
  } catch {
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
    // ONE ENTRY PER NETWORK. A reader deciding whether they can pay us needs
    // the address in their own chain's format; a single `payTo` would answer
    // that question for one audience and mislead the other.
    accepts: config.legs.map((leg) => ({
      network: leg.network,
      networkLabel: leg.networkLabel,
      payTo: leg.payTo,
      asset: leg.asset,
      scheme: "exact",
    })),
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
