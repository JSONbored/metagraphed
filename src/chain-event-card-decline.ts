// What a chain-event card publishes when its tier could not be read (#11417).
//
// ## Why one module rather than a decline per card
//
// `/chain/serving`, `/chain/prometheus` and `/chain/weights` publish the same
// six fields over the same rollup, and their per-subnet siblings differ only in
// what the rows are counting. Writing the decline three times is three chances
// to spell it differently, which is exactly how `degraded` came to mean two
// things across the route table before #11417.
//
// ## Why the NETWORK block goes null rather than to zeros
//
// The block is the confident zero this whole issue is about: `announcements: 0,
// distinct_servers: 0` is a statement that nobody served anything, and after a
// fifteen-second timeout nobody knows that. Nulling the block says the honest
// thing once, instead of nulling four or five nested counts per card and
// widening every one of their types.
//
// It is also the encoding these cards ALREADY use for "unknown":
// `intensity_distribution` has been `number | null` since it shipped, null
// meaning the spread could not be computed. A null `network` reads the same way
// to the same caller.
//
// ## What stays non-null
//
// `window` and `schema_version`, because both are known without reading
// anything -- the caller asked for the window and the contract version is ours.
// `subnets` stays an EMPTY ARRAY rather than null so a consumer mapping over it
// does not have to branch; `degraded` is what tells it the array is not a
// measurement.

import {
  DEGRADED_UNAVAILABLE,
  type EventStreamDegraded,
} from "./uncurated-event-streams.ts";

/**
 * The fields every chain-event card nulls when its read declined.
 *
 * Deliberately NOT the full card type: each card's `network` and `subnets` are
 * its own, so this describes the shared decline and each card's result type
 * widens `subnet_count` and `network` to accept it.
 */
export interface ChainEventCardDecline {
  schema_version: 1;
  window: string | null;
  /** No read, so no reading instant. Never `new Date()` -- that would date an
   * empty card to now. */
  observed_at: null;
  /** NULL, not 0: how many subnets the window covers is exactly what was not
   * learned. */
  subnet_count: null;
  network: null;
  intensity_distribution: null;
  subnets: [];
  degraded: EventStreamDegraded;
}

/**
 * The decline payload for a chain-event card.
 *
 * Used ONLY for a `gap` -- a configured lakehouse that could not answer. An
 * `empty` or a `miss` keeps the card's own zeros and carries no marker, because
 * in those cases the zeros are either a measurement or the correct answer for a
 * deployment with no lakehouse at all.
 */
export function declineChainEventCard(
  /**
   * REQUIRED, and nullable rather than optional: every caller resolves its
   * window before reading, so an omitted one is not a case that exists. A
   * `window?:` default would be an unreachable branch standing in for it.
   */
  window: string | null,
): ChainEventCardDecline {
  return {
    schema_version: 1,
    window,
    observed_at: null,
    subnet_count: null,
    network: null,
    intensity_distribution: null,
    subnets: [],
    degraded: { reason: DEGRADED_UNAVAILABLE },
  };
}
