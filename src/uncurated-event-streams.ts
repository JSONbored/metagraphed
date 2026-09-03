// Availability markers for event-derived routes.
//
// Prometheus windows are measured zeros after a successful source read. An
// unavailable source uses DEGRADED_UNAVAILABLE so its empty fallback cannot
// be mistaken for a quiet window. Historical curation is repaired from the
// complete chain_events stream; a past missing-row count is not a permanent
// property of this API.
//
// Other markers describe the source or derivation used by their own route.
// They are additive and absent from measured answers.

/** A route's own statement that its zero is not a measurement. */
export interface EventStreamDegraded {
  reason: string;
  detail?: string;
}

/**
 * The requested source could not answer this read. The route's response
 * schema determines whether its fallback counts are null or zero; this
 * marker always says they are not measurements. Successfully read quiet
 * windows do not carry it.
 *
 * Proxied chain-events routes use TIER_UNAVAILABLE_REASON ("tier_unavailable",
 * src/chain-events-degraded.ts) on their separate response paths. Keep each
 * route's published reason stable.
 */
export const DEGRADED_UNAVAILABLE = "unavailable";

/**
 * `AxonInfoRemoved` has ZERO occurrences in the complete pallet-level stream,
 * ever. The routes were modelled on an event the Subtensor runtime does not
 * emit, so no indexer work can populate them.
 *
 * Unlike deregistration -- implicit in the chain but derivable from UID reuse
 * (src/deregistration-derivation.ts) -- an axon going away is a STATE
 * transition (`AxonInfo` cleared, or its `block` going stale), not an event,
 * and nothing in the event streams observes it. So there is no derivation to
 * ship here.
 *
 * The remaining options are to derive it from axon-info state if the poller
 * can observe that transition, or to RETIRE the route family and say so in
 * the contract. Retiring a published route is a contract decision for the
 * repo owner, not something this marker presumes; what it does settle is that
 * publishing a confident 0 forever was never one of the options.
 */
export const AXON_REMOVALS_DEGRADED_NEVER_EMITTED =
  "axon_removals_never_emitted";

/**
 * The deregistration derivation could not answer THIS request: the projection
 * artifact is unbound, absent, unreadable, or does not carry the requested
 * window (src/chain-deregistrations-artifact.ts declines rather than
 * answering with a different window's numbers).
 *
 * Distinct from the two above: the data exists and the derivation works, this
 * particular read just did not get it. The zero underneath is the same
 * schema-stable empty the route always served -- the marker is what stops it
 * being read as a measurement.
 */
export const DEREGISTRATIONS_DEGRADED_NOT_DERIVED =
  "deregistrations_not_derived";
