// The event streams a route filters on that its tier cannot actually deliver.
//
// THE DEFECT THIS NAMES. `/chain|subnets|accounts .../prometheus` and
// `.../axon-removals` answered 200 with every array empty and a 0 count, on
// every scope, for every subject, permanently -- while their siblings in the
// same family, same window, same table answered real numbers. A well-formed
// zero is indistinguishable from "nothing happened this week", so the routes
// read as measured quiet rather than as a missing reader. That is the class of
// #9260, #9263, #9273 and #9286, and it is what these markers close.
//
// MEASURED against the lakehouse (2026-08-03) -- `chain.chain_events` is the
// COMPLETE pallet-level stream (898M rows, genesis to head) and
// `chain.account_events` is the curated projection over it:
//
//   event kind          chain_events   account_events
//   AxonServed (ctl)       2,792,038        2,792,038
//   NeuronRegistered (ctl) 1,072,413        1,072,413
//   PrometheusServed          18,041                0
//   AxonInfoRemoved                0                0
//
// Two different faults with the same symptom, so they get two different
// reasons rather than one vague one. Neither is a transient tier outage, so
// neither marker is conditional on a store being cold: the marker rides the
// EMPTY answer itself, which is the only answer these streams can produce.
//
// A marked payload is otherwise byte-identical to what it served before --
// `degraded` is additive and absent from every trustworthy answer, so a
// consumer that ignores it reads exactly what it read before.

/** A route's own statement that its zero is not a measurement. */
export interface EventStreamDegraded {
  reason: string;
  detail?: string;
}

/**
 * The chain emits `PrometheusServed` and our `account_events` curation drops
 * it: 18,041 events in the complete stream, 0 in the projection every
 * prometheus route reads. A CURATION gap, not a chain fact -- the fix is
 * upstream in the indexer's extract() match arm (metagraphed-infra #242) plus
 * a backfill, neither of which lives in this repo.
 *
 * Worth stating precisely, because "deploy #242 and the route lights up" is
 * only half true: the newest `PrometheusServed` in the complete stream is
 * 2026-07-19 and exactly ONE lands inside the widest window these routes
 * offer (30d). Curating it makes the routes correct; it does not make them
 * busy. The 18,041 are historical and reach back to 2023-03-20, so the
 * backfill is what makes them visible at all.
 */
export const PROMETHEUS_DEGRADED_NOT_CURATED = "prometheus_stream_not_curated";

/*
 * AXON REMOVALS: RESOLVED BY DERIVATION, 2026-08-16 (#10805).
 *
 * This block used to declare `axon_removals_never_emitted`, the marker three
 * routes carried because `AxonInfoRemoved` has zero occurrences in the
 * complete pallet-level stream, genesis to head. Its own text set out the only
 * two honest ways forward: "derive it from axon-info state if the poller can
 * observe that transition, or RETIRE the route family".
 *
 * The first was taken. `neuron_daily` does observe the transition, and
 * src/axon-reachability-changes.ts derives it -- correctly, which turned out
 * to matter: the obvious derivation is wrong 95% of the time, because 1,915 of
 * 2,186 transitions over 38 days are deregistrations and another 166 are
 * miners moving to an unroutable address. Only 105 are a miner that stopped
 * announcing.
 *
 * The marker is gone because the routes answer now. What replaced it is
 * stronger than a flag: an unread window has a NULL `start_date`, which a
 * measured zero does not -- a new field can forget to set a marker, but it
 * cannot forge dates it never read.
 */

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
