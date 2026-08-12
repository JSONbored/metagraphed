// When a subnet was registered or deregistered (#10263).
//
// The per-UID side of this question has been answerable for a long time --
// `registered_at_block`, `is_immunity_period`, three deregistration routes. The
// per-SUBNET side had no surface at all, which is why "how many subnets existed
// on 2026-06-01" was unanswerable and a deregistered subnet's hyperparams
// lingered with nothing recording that it left.
//
// Backed by `subnet_lifecycle` in Neon, appended by the detection folded into
// the neurons-staleness tick (#10262).
import { z } from "zod";
import { subnetEntryListSchema } from "../shared.ts";

/**
 * The two transitions.
 *
 * A closed set, and deliberately only two: "emission enabled" is a different
 * event with its own history (`subnet_emission_enabled_history`), and folding
 * it in here would make `event` mean two incomparable things.
 */
export const SUBNET_LIFECYCLE_EVENTS = ["registered", "deregistered"] as const;

export const SubnetLifecycleEntrySchema = z
  .object({
    netuid: z.int().min(0),
    event: z.enum(SUBNET_LIFECYCLE_EVENTS),
    /**
     * The block the transition was observed at, or null.
     *
     * NULL IS A REAL ANSWER and must not be read as block 0. It means either
     * that the transition predates capture (see `predates_capture`) or that the
     * detecting pass could not attribute a block. A lifecycle event with no
     * block is still a fact worth keeping; a fabricated block is not.
     */
    block_number: z.int().min(0).nullable(),
    observed_at: z.string(),
    /**
     * True for the seed rows: this subnet already existed when detection began,
     * so its registration is older than anything we can see.
     *
     * Kept in the payload rather than filtered out server-side because a
     * consumer counting registrations over time needs to exclude them, and a
     * consumer listing "when did this subnet appear" needs to show them as
     * "before <date>" rather than as a date.
     */
    predates_capture: z.boolean(),
  })
  .strict()
  .describe(
    "One observed subnet transition. block_number is null when the event predates capture or the detecting pass could not attribute one; that is a fact, not a gap.",
  );
export type SubnetLifecycleEntry = z.infer<typeof SubnetLifecycleEntrySchema>;

export const SubnetLifecycleArtifactSchema = subnetEntryListSchema(
  SubnetLifecycleEntrySchema,
);
export type SubnetLifecycleArtifact = z.infer<
  typeof SubnetLifecycleArtifactSchema
>;

/**
 * The network-wide feed: every subnet's transitions, newest first.
 *
 * Separate artifact rather than the per-subnet one with `netuid` omitted,
 * because the questions differ. "What has this subnet done" is a history;
 * "what changed on the network lately" is a feed, and a feed wants the netuid
 * on every row.
 */
export const ChainSubnetLifecycleArtifactSchema = z
  .object({
    schema_version: z.int(),
    entry_count: z.int().min(0),
    /** Distinct subnets appearing in this page. Context for the count above. */
    subnet_count: z
      .int()
      .min(0)
      .describe(
        "Distinct subnets appearing in this page -- context for entry_count.",
      ),
    limit: z.int().min(1).max(1000).nullable().optional(),
    offset: z.int().min(0).nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    entries: z.array(SubnetLifecycleEntrySchema),
  })
  .strict();
export type ChainSubnetLifecycleArtifact = z.infer<
  typeof ChainSubnetLifecycleArtifactSchema
>;
