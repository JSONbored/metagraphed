// Shared route policy for discovery and payment handling. Keep settlement
// dependencies out of callers that only need to publish a route price.
import { routeCost } from "./route-cost-weights.ts";

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

/**
 * The route families a payment can buy headroom on, and nothing else.
 *
 * Being on this list does NOT make a route paid. It makes a route one where a
 * caller MAY present a payment to be treated as keyed rather than anonymous.
 *
 * An allowlist rather than a cost-weight threshold, because "expensive" and
 * "worth offering headroom on" are different questions.
 */
export const X402_PAID_FAMILIES: readonly string[] = [
  "ai",
  "deep-history",
  "export",
];

/**
 * The families where a payment is REQUIRED, not merely accepted (#11600).
 *
 * Everything in X402_PAID_FAMILIES accepts a payment and gives headroom for
 * it. These additionally REFUSE without one -- an unpaid call gets a 402
 * instead of the anonymous tier.
 *
 * ## WHY THIS DOES NOT BREAK THE INVARIANT
 *
 * The invariant is that a payment never gates a call that WOULD HAVE
 * SUCCEEDED. An export call has never succeeded for anyone: the family is new,
 * nothing in apps/ui calls it, and no free tier of it was ever offered. There
 * is no behaviour here to take away.
 *
 * That is also why it is a separate family rather than a flag on the existing
 * ones. `ai` and `deep-history` are called anonymously by our own website --
 * /api/v1/ask from the Ask feature and the command palette, /api/v1/blocks and
 * /api/v1/chain-events from the block explorer, with a user-typed block range.
 * Requiring payment on either would 402 a visitor reading our own site.
 *
 * A caller who wants those for free still gets them, paginated, exactly as
 * before. What costs money is the shape that costs US money: one unpaginated
 * pass over a window the free tier does not offer.
 */
export const X402_REQUIRED_FAMILIES: readonly string[] = ["export"];

/** Does this route refuse a caller who presents no payment at all? */
export function x402RequiresPayment(pathname: string): boolean {
  return X402_REQUIRED_FAMILIES.includes(routeCost(pathname).family);
}

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
