// GET /api/v1/subnets/{netuid}/deregistration-ranking/history (#10296): one
// subnet's trajectory toward or away from the pruning bar. Modeled from
// src/subnet-deregistration-history.ts's buildDeregistrationHistory().
//
// The rank is REPLAYED from stored inputs on read, never stored -- see that
// module's header -- so every field here is either a measured input or a
// derivation of the current pallet rule over one.
import { z } from "zod";
import { dailySubnetSeriesArtifact } from "./daily-subnet-series.ts";

export const DeregistrationHistoryPointSchema = z
  .object({
    day: z.string(),
    /** The chain state this point describes. Required -- a point that cannot
     * say which block it came from cannot be placed in a series. */
    pinned_block: z
      .int()
      .min(0)
      .describe(
        "The chain state this point's inputs were read at. A day that cannot say which block it came from is not served.",
      ),
    /** True when the day carries the previous day's observation rather than a
     * fresh one: this point is NOT an independent sample. */
    repeats_previous_observation: z
      .boolean()
      .describe(
        "True when this day carries the previous day's observation rather than a fresh read: NOT an independent sample, so a rank that looks unchanged may simply not have been re-measured.",
      ),
    captured_at: z.iso.datetime().nullable(),
    /** NULL while immune. */
    rank: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "Position in the pallet's pruning order that day, 1 = next to deregister. NULL while immune: an immune subnet holds no position in the prunable order, and reporting one would invent a standing it does not have. Read `immune` to tell that from an unreadable rank.",
      ),
    immune: z
      .boolean()
      .describe(
        "Inside NetworkRegisteredAt + NetworkImmunityPeriod at this block, so it cannot be pruned at all.",
      ),
    immune_until_block: z.int().min(0).nullable(),
    blocks_until_prunable: z
      .int()
      .min(0)
      .describe(
        "0 once prunable; how far protection still reaches while immune.",
      ),
    /** What the pallet compares -- a FLAT 1.0 for a Stable subnet. */
    comparison_price: z
      .number()
      .describe(
        "What get_network_to_prune() actually compares: SubnetMovingPrice, except a Stable (SubnetMechanism 0) subnet substitutes a FLAT 1.0. Published beside moving_price so the substitution is visible rather than inferred.",
      ),
    moving_price: z
      .number()
      .nullable()
      .describe(
        "The raw SubnetMovingPrice read at pinned_block. NULL is not zero -- a subnet with no price is not a subnet priced at zero, though the pallet's ValueQuery makes an ABSENT entry compare as 0.",
      ),
    registered_at_block: z.int().min(0),
    subnet_mechanism: z.int().min(0),
    network_immunity_period: z.int().min(0),
    /** The field size, because rank 94 means different things in a field of
     * 100 and a field of 128. */
    ranked_count: z
      .int()
      .min(0)
      .describe(
        "How many subnets were prunable that day. A rank means different things in a field of 100 and a field of 128, so the denominator rides with it.",
      ),
    immune_count: z.int().min(0),
    next_to_deregister: z
      .int()
      .min(0)
      .nullable()
      .describe("Which netuid held rank 1 that day."),
    next_to_deregister_comparison_price: z
      .number()
      .nullable()
      .describe(
        "Rank 1's comparison_price that day. Published rather than a pre-computed gap, because the distance that matters depends on the question being asked.",
      ),
  })
  .strict();

export const DeregistrationHistoryArtifactSchema = dailySubnetSeriesArtifact(
  DeregistrationHistoryPointSchema,
  {
    pointCount: "Points emitted. NOT the number of times the inputs were read.",
    distinctObservations:
      "Independent observations -- the honest denominator for any claim that a rank MOVED. Counts distinct pinned_block values, never ranks compared for equality.",
    firstCapturedDay:
      "The first day the daily lane ever wrote, so a short series reads as a start rather than a gap.",
    degraded:
      "Present ONLY on a decline. An empty series is a measurement -- a subnet registered after the lane began returns one legitimately.",
  },
);
export type DeregistrationHistoryArtifact = z.infer<
  typeof DeregistrationHistoryArtifactSchema
>;
/** The point shape the builder emits, named so src/subnet-deregistration-history.ts
 * can type its accumulator against the published contract rather than against a
 * bare record -- which is what stops a field being added to one and not the
 * other. */
export type DeregistrationHistoryPoint = z.infer<
  typeof DeregistrationHistoryPointSchema
>;
