// Which subnet the chain would deregister next (#10285).
//
// ## The rule is the pallet's, not ours
//
// `Subtensor::get_network_to_prune()` (pallets/subtensor/src/coinbase/root.rs)
// picks the victim when a registration would exceed `SubnetLimit`. It walks
// every added netuid and:
//
//   1. skips root;
//   2. skips any subnet still inside `NetworkRegisteredAt + NetworkImmunityPeriod`;
//   3. compares `get_moving_alpha_price(netuid)`;
//   4. breaks a price tie on the EARLIER `NetworkRegisteredAt`.
//
// This module reproduces exactly that ordering, and publishes the whole order
// rather than only the winner -- the question a subnet owner asks is "how close
// am I", which is a rank, not a boolean.
//
// ## Why this is not "sort by moving_price"
//
// Measured against mainnet at block 8,808,300, a price-only sort names
// **netuid 86** as next to be pruned. It is not: 86 sits at a moving price of
// exactly 0 and heads any price order, but it registered inside the immunity
// window and cannot be deregistered at all. The chain's own answer is netuid
// 70. Two of the naive top ten were immune, and sixteen subnets were immune
// overall.
//
// That is the whole reason this module exists as a rule rather than an
// `ORDER BY moving_price`: the wrong answer is not obviously wrong. It is a
// plausible, confident, believed ranking that disagrees with the chain.
//
// ## The mechanism clause looks dead and is not
//
// `get_moving_alpha_price` returns a flat 1.0 when `SubnetMechanism == 0`
// (Stable) instead of reading `SubnetMovingPrice`. Every mainnet subnet reads
// mechanism 1 today, so this branch changes nothing right now -- and a Stable
// subnet would sort to the very TOP of a price order while the chain places it
// near the bottom, so the day it stops being dead is the day the published
// ranking would be wrong at position one.
//
// ## Declining beats guessing
//
// Every input is required. Without `network_immunity_period` there is no way
// to tell a prunable subnet from a protected one, and an ordering computed
// without it is not "approximate" -- it is a different ordering that looks the
// same. `rankDeregistration` returns a reason instead of a partial list.

import type { FieldSources } from "./field-provenance.ts";

/**
 * Where each published value came from.
 *
 * `comparison_price` is `reconstructed` even though it usually equals a single
 * storage read: on a Stable subnet it is a constant the pallet substitutes,
 * so the field is our reproduction of `get_moving_alpha_price` rather than a
 * measurement — and labelling it `measured` would attribute the substitution
 * to the chain.
 */
export const DEREGISTRATION_FIELD_SOURCES = {
  moving_price: {
    kind: "measured",
    storage: "SubtensorModule.SubnetMovingPrice",
  },
  registered_at_block: {
    kind: "measured",
    storage: "SubtensorModule.NetworkRegisteredAt",
  },
  subnet_mechanism: {
    kind: "measured",
    storage: "SubtensorModule.SubnetMechanism",
  },
  network_immunity_period: {
    kind: "measured",
    storage: "SubtensorModule.NetworkImmunityPeriod",
  },
  comparison_price: { kind: "reconstructed", storage: null },
  rank: { kind: "reconstructed", storage: null },
  immune: { kind: "reconstructed", storage: null },
  immune_until_block: { kind: "reconstructed", storage: null },
  blocks_until_prunable: { kind: "reconstructed", storage: null },
  next_to_deregister: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

/** The flat price the pallet substitutes for a Stable subnet's moving price. */
export const STABLE_MECHANISM_PRICE = 1;

/** `SubnetMechanism` value the pallet treats as Stable. */
export const STABLE_MECHANISM = 0;

/** Root is never a pruning candidate. */
export const ROOT_NETUID = 0;

export interface DeregistrationCandidateInput {
  netuid: number;
  /** `SubnetMovingPrice`, already decoded. */
  moving_price: number | null;
  /** `NetworkRegisteredAt`, in blocks. */
  registered_at_block: number | null;
  /** `SubnetMechanism`; 0 is Stable and forces the comparison price to 1.0. */
  subnet_mechanism: number | null;
}

export interface DeregistrationRankEntry {
  netuid: number;
  /** 1-based position in the pallet's order. Immune subnets have none. */
  rank: number | null;
  /** The value the pallet actually compares -- 1.0 for a Stable subnet. */
  comparison_price: number;
  /** The raw storage read, kept so a caller can see the substitution. */
  moving_price: number | null;
  registered_at_block: number;
  subnet_mechanism: number;
  immune: boolean;
  /** Block at which immunity lapses; the subnet joins the order then. */
  immune_until_block: number | null;
  /** Blocks remaining, 0 once prunable. */
  blocks_until_prunable: number;
}

export interface DeregistrationRanking {
  block: number;
  network_immunity_period: number;
  /** Ordered: rank 1 is the subnet the chain would deregister next. */
  ranked: DeregistrationRankEntry[];
  /** Immune subnets, which are NOT ranked -- they cannot be pruned at all. */
  immune: DeregistrationRankEntry[];
  next_to_deregister: number | null;
}

export type DeregistrationDeclineReason =
  "immunity_period_unavailable" | "block_unavailable" | "no_candidates";

export type DeregistrationRankingResult =
  | { ok: true; ranking: DeregistrationRanking }
  | { ok: false; reason: DeregistrationDeclineReason };

/**
 * The price the pallet compares, which is not always the price it stores.
 *
 * A missing `moving_price` reads as 0 rather than being dropped: the pallet
 * uses `ValueQuery`, so an absent entry genuinely IS zero there, and zero is
 * the most-prunable value -- silently excluding such a subnet would remove the
 * single likeliest victim from the order.
 */
export function comparisonPrice(input: DeregistrationCandidateInput): number {
  if (input.subnet_mechanism === STABLE_MECHANISM)
    return STABLE_MECHANISM_PRICE;
  return input.moving_price ?? 0;
}

/**
 * Rank live subnets in the chain's own deregistration order.
 *
 * `block` is the height immunity is judged at, and must be the height the
 * candidates were read at -- comparing a registration height against a
 * different tip is how a subnet lands on the wrong side of the window.
 */
export function rankDeregistration(input: {
  block: number | null | undefined;
  networkImmunityPeriod: number | null | undefined;
  candidates: readonly DeregistrationCandidateInput[];
}): DeregistrationRankingResult {
  const { block, networkImmunityPeriod, candidates } = input;
  if (!Number.isFinite(block) || (block as number) <= 0) {
    return { ok: false, reason: "block_unavailable" };
  }
  // Zero is a legitimate immunity period (no subnet is ever protected), so the
  // guard is on readability, not on truthiness.
  if (
    !Number.isFinite(networkImmunityPeriod) ||
    (networkImmunityPeriod as number) < 0
  ) {
    return { ok: false, reason: "immunity_period_unavailable" };
  }
  const at = block as number;
  const immunity = networkImmunityPeriod as number;

  const entries: DeregistrationRankEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.netuid === ROOT_NETUID) continue;
    if (!Number.isInteger(candidate.netuid) || candidate.netuid < 0) continue;
    const registeredAt = Number.isFinite(candidate.registered_at_block)
      ? (candidate.registered_at_block as number)
      : 0;
    const immuneUntil = registeredAt + immunity;
    const immune = at < immuneUntil;
    entries.push({
      netuid: candidate.netuid,
      rank: null,
      comparison_price: comparisonPrice(candidate),
      moving_price: candidate.moving_price ?? null,
      registered_at_block: registeredAt,
      subnet_mechanism: candidate.subnet_mechanism ?? 0,
      immune,
      immune_until_block: immune ? immuneUntil : null,
      blocks_until_prunable: immune ? immuneUntil - at : 0,
    });
  }
  if (entries.length === 0) return { ok: false, reason: "no_candidates" };

  const immune = entries
    .filter((entry) => entry.immune)
    // Soonest to lose protection first -- the order in which they JOIN the
    // ranking, which is the only ordering this list can carry that means
    // anything. Ranking them by price would imply a position they do not have.
    .sort(
      (a, b) =>
        a.blocks_until_prunable - b.blocks_until_prunable ||
        a.netuid - b.netuid,
    );

  const ranked = entries
    .filter((entry) => !entry.immune)
    .sort(
      (a, b) =>
        a.comparison_price - b.comparison_price ||
        // The pallet's tie-break: on equal price the EARLIER registration is
        // taken. Inverting this would hand a new subnet's protection to an old
        // one on every tie, and ties are not rare -- an unset moving price
        // reads 0 for every subnet that has one.
        a.registered_at_block - b.registered_at_block ||
        a.netuid - b.netuid,
    )
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return {
    ok: true,
    ranking: {
      block: at,
      network_immunity_period: immunity,
      ranked,
      immune,
      next_to_deregister: ranked[0]?.netuid ?? null,
    },
  };
}

/** The 503 a degraded capture gets, rather than a plausible-looking body. */
export const DEREGISTRATION_UNAVAILABLE_CODE =
  "deregistration_ranking_unavailable";
export const DEREGISTRATION_UNAVAILABLE_MESSAGE =
  "The deregistration order needs a pinned block and NetworkImmunityPeriod. " +
  "Without the immunity window the result is not an approximate order, it is " +
  "a different one that looks identical -- so this declines rather than serves it.";

interface EconomicsBlob {
  chain_state?: {
    block?: unknown;
    network_immunity_period?: unknown;
  } | null;
  subnets?: unknown;
}

/**
 * Project a resolved economics blob into the served ranking.
 *
 * Null -- never a partial body -- when the capture carries no pinned block or
 * no immunity period; the caller turns that into its own surface's error.
 */
export function projectDeregistrationRanking(economics: unknown):
  | (DeregistrationRanking & {
      schema_version: number;
      chain_state: unknown;
      ranked_count: number;
      immune_count: number;
      field_sources: typeof DEREGISTRATION_FIELD_SOURCES;
    })
  | null {
  const blob = (economics ?? {}) as EconomicsBlob;
  const chainState = blob.chain_state ?? null;
  if (!chainState) return null;
  const rows = Array.isArray(blob.subnets) ? blob.subnets : [];
  const candidates: DeregistrationCandidateInput[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    if (!Number.isInteger(row?.netuid)) continue;
    candidates.push({
      netuid: row.netuid as number,
      moving_price:
        typeof row.moving_price_pinned === "number"
          ? row.moving_price_pinned
          : null,
      registered_at_block:
        typeof row.registered_at_block === "number"
          ? row.registered_at_block
          : null,
      subnet_mechanism:
        typeof row.subnet_mechanism === "number" ? row.subnet_mechanism : null,
    });
  }
  const result = rankDeregistration({
    block: typeof chainState.block === "number" ? chainState.block : null,
    networkImmunityPeriod:
      typeof chainState.network_immunity_period === "number"
        ? chainState.network_immunity_period
        : null,
    candidates,
  });
  if (!result.ok) return null;
  return {
    schema_version: 1,
    chain_state: chainState,
    ...result.ranking,
    ranked_count: result.ranking.ranked.length,
    immune_count: result.ranking.immune.length,
    field_sources: DEREGISTRATION_FIELD_SOURCES,
  };
}
