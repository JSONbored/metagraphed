// The paid-depth seam (#11179 phase 2): where a call crosses from what every
// caller gets into what a tier buys, and the refusal that says so.
//
// ## WHY A REFUSAL, NOT A HIDDEN TOOL
//
// The decision this repo measured twice: absence reads as nonexistence. An
// unregistered mutation reads as "no such route" (#11146); an empty captured
// schema reads as "no such API" (#11148). A paid tool hidden from free callers
// is the same failure a third time -- nobody discovers it, so nobody upgrades
// for it. So TIER GATES DEPTH, NEVER VISIBILITY: every tool stays listed for
// everyone, and a call that crosses a paid boundary gets a structured refusal
// naming the boundary, the tier that clears it, and where to get one. An agent
// relays that to its human, which makes the MCP its own sales channel.
//
// ## THE SHAPE IS X402-READY ON PURPOSE
//
// The refusal carries `code: "payment_required"` plus a `payment` block naming
// the required tier and the upgrade path. When per-call machine payment lands
// (x402: HTTP 402 + a payment challenge), the challenge is another member of
// that same block -- not a second error vocabulary an agent has to learn. This
// module builds the seam; it deliberately does not build the payment leg.
//
// ## WHAT THIS MODULE DOES NOT DECIDE
//
// WHICH boundary is paid. That is #11179 phase 3, and the issue is explicit
// that the first boundary comes from usage analytics rather than intuition --
// `authTier` has ridden every `$mcp_tool_call` since #8967 precisely so the
// question can be answered with data. Until a boundary is declared, this
// module is a mechanism with no live callers, which is the intended state.

import { API_TIERS, type ApiTier } from "./api-tiers.ts";

/**
 * Tier ranking, lowest first. `anonymous` is the tier
 * `applyTieredRateLimit` reports for a caller with no valid key -- it is a
 * real answer, not a missing one, so it ranks rather than falling through.
 */
export const MCP_TIER_RANK: readonly string[] = ["anonymous", ...API_TIERS];

/** Where a caller gets a key. One string, so refusal and docs cannot drift. */
export const MCP_UPGRADE_URL = "https://metagraph.sh/docs/limits";

/**
 * Does `tier` clear `required`?
 *
 * An UNRECOGNISED tier ranks below everything: a tier name this build does not
 * know is not evidence of entitlement, and the alternative -- treating unknown
 * as "probably fine" -- turns a typo in an account record into free access to
 * every paid boundary. The same reasoning as the own-property lookup in
 * applyTieredRateLimit, where an unrecognised tier falls back to the safer
 * policy rather than the inherited one.
 */
export function tierClears(tier: string | null | undefined, required: ApiTier) {
  const have = MCP_TIER_RANK.indexOf(String(tier ?? ""));
  const need = MCP_TIER_RANK.indexOf(required);
  return have >= 0 && have >= need;
}

export interface PaymentRequiredDetails {
  /** The tier the caller was measured at, verbatim from the rate limiter. */
  tier: string;
  /** The tier that clears this boundary. */
  requiredTier: ApiTier;
  /**
   * WHAT was crossed, as a stable slug (e.g. `history_window_days`) -- an
   * agent branches on this to retry within the free depth instead of
   * re-parsing prose. Paired with the limit that applies at the caller's tier
   * so the retry is computable, not guessed.
   */
  boundary: string;
  /** The caller's own ceiling for `boundary`, when the boundary is numeric. */
  freeLimit?: number;
  /**
   * What the caller asked for, so the refusal shows both sides. `null` means
   * UNBOUNDED (a window like `all`), which crosses every finite ceiling.
   */
  requested?: number | null;
}

/**
 * The refusal. Thrown like any other tool error, so it rides the existing
 * `structuredContent.error` path -- the `payment` block is what makes it
 * actionable, and what an x402 challenge will later extend.
 */
export function paymentRequiredToolError(details: PaymentRequiredDetails) {
  const scope =
    details.freeLimit === undefined
      ? `The ${details.boundary} you requested`
      : `A ${details.boundary} above ${details.freeLimit}`;
  const asked =
    details.requested === undefined
      ? ""
      : ` (requested ${details.requested ?? "unbounded"})`;
  const error = new Error(
    `${scope}${asked} needs the ${details.requiredTier} tier; this call was ` +
      `measured at ${details.tier}. Every tool stays callable at every tier -- ` +
      `retry within your tier's limit, or see ${MCP_UPGRADE_URL}.`,
  ) as Error & {
    toolError: boolean;
    code: string;
    payment: Record<string, unknown>;
  };
  error.toolError = true;
  error.code = "payment_required";
  error.payment = {
    tier: details.tier,
    required_tier: details.requiredTier,
    boundary: details.boundary,
    upgrade_url: MCP_UPGRADE_URL,
    ...(details.freeLimit === undefined ? {} : { limit: details.freeLimit }),
    ...(details.requested === undefined
      ? {}
      : { requested: details.requested }),
  };
  return error;
}

/**
 * The free history depth, in days (#11179 phase 3).
 *
 * CHOSEN FROM USAGE, not intuition, per the issue. Over the 30 days to
 * 2026-08-14 the economics family carried the most DISTINCT callers of any
 * tool (`get_subnet_economics`: 52, above `get_subnet_health`'s 47 on a third
 * the volume), which makes economic history the demand centre the issue
 * predicted. Effectively all of that traffic is anonymous, so the free depth
 * has to stay a real product rather than a teaser: 90 days keeps the `7d`,
 * `30d` and `90d` windows -- every window an interactive question needs --
 * and gates only `1y` and `all`, the two unbounded-shaped reads that scan the
 * whole rollup.
 */
export const FREE_HISTORY_WINDOW_DAYS = 90;

/**
 * Guard a numeric depth boundary: returns nothing when the caller clears it,
 * throws the refusal when it does not.
 *
 * `limit` is the ceiling at the CALLER's tier. A caller who already clears
 * `requiredTier` is never bounded here, and a request at or under the limit
 * passes regardless of tier -- the free depth is a real product, not a teaser.
 */
export function requireTierForDepth(options: {
  tier: string;
  requiredTier: ApiTier;
  boundary: string;
  /** `null` = unbounded, which crosses every finite ceiling. */
  requested: number | null;
  limit: number;
}): void {
  if (options.requested !== null && options.requested <= options.limit) return;
  if (tierClears(options.tier, options.requiredTier)) return;
  throw paymentRequiredToolError({
    tier: options.tier,
    requiredTier: options.requiredTier,
    boundary: options.boundary,
    freeLimit: options.limit,
    requested: options.requested,
  });
}
