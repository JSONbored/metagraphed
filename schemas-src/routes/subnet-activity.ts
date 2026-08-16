// GET /api/v1/subnets/{netuid}/{axon-removals,deregistrations,registrations,
// serving} (types-epic B batch 1, #8055). Four live account_events-window
// scorecards sharing one shape (netuid/window/observed_at + a distinct-actor
// count/event count/per-actor ratio, field names varying by kind) -- no
// static file. Modeled from src/subnet-axon-removals.ts, subnet-
// deregistrations.ts, subnet-registrations.ts, subnet-serving.ts's
// buildSubnet*() functions (byte-identical structure across all four,
// verified by reading all four source files), cross-checked against the
// four hand-edited Subnet*Artifact components they replace.
import { z } from "zod";
import {
  DeregistrationDerivationSchema,
  EventStreamDegradedSchema,
} from "./event-stream-honesty.ts";
import {
  AxonChangeBreakdownSchema,
  AxonChangesCoverageShape,
  AxonChangesDerivationSchema,
} from "./chain-network-rollups.ts";

const ACTIVITY_WINDOWS = ["7d", "30d"] as const;

// Every buildSubnet*() always sets window (arg ?? null), so null is a real,
// reachable value (an un-labeled call), not just defensive typing -- kept
// nullable to match the hand-edited originals exactly.
const ActivityWindowSchema = z.enum(ACTIVITY_WINDOWS).nullable();

export const SubnetAxonRemovalsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "Midnight UTC of the last day read -- the answer describes a day, not an instant.",
      ),
    ...AxonChangesCoverageShape,
    distinct_removers: z.int().min(0),
    removals: z
      .int()
      .min(0)
      .describe(
        "Miners that STOPPED ANNOUNCING. Deregistrations and moves to unroutable addresses are in `changes` instead, because neither removed anything.",
      ),
    removals_per_remover: z.number().min(0).nullable(),
    changes: AxonChangeBreakdownSchema,
    derivation: AxonChangesDerivationSchema,
  })
  .strict();
export type SubnetAxonRemovalsArtifact = z.infer<
  typeof SubnetAxonRemovalsArtifactSchema
>;

export const SubnetDeregistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_deregistered_hotkeys: z.int().min(0),
    deregistrations: z.int().min(0),
    deregistrations_per_hotkey: z.number().min(0).nullable(),
    /**
     * The individual evictions behind the counts above (#9873).
     *
     * The scalar answers "how much churn does this subnet have"; an operator
     * asking "is MY uid at risk, and how soon" needs the events. Each row
     * names the UID that turned over, the hotkey that LOST it, the hotkey that
     * took it, and how long the loser had held it -- enough for a caller to
     * work out whether pruning is oldest-first, lowest-incentive-first or
     * something else, which is what the reporter actually asked for.
     *
     * DELIBERATELY NOT A RISK SCORE. Publishing one would be a model presented
     * as a measurement, the failure `is_lower_bound` exists to prevent.
     *
     * Same lower-bound caveat as the counts: an eviction whose displaced
     * holder registered before the lookback cannot be attributed, and those
     * are counted in `derivation.unattributed_registrations` rather than
     * appearing here with a guessed hotkey.
     */
    events: z
      .array(
        z
          .object({
            uid: z.int().min(0),
            /** The DISPLACED holder — this event is a deregistration OF it. */
            hotkey: z.string(),
            replaced_by_hotkey: z.string(),
            block_number: z.int().min(0),
            observed_at: z.iso.datetime(),
            /**
             * Blocks the displaced holder kept the slot. Null when the two
             * registrations carry no usable ordering — never 0, which would
             * read as "evicted instantly" rather than "not measurable".
             */
            tenure_blocks: z.int().min(1).nullable(),
          })
          .strict(),
      )
      .optional(),
    // #9307: derived from UID reuse out of the same projection rows the chain
    // leaderboard ranks; `degraded` when nothing derived it.
    derivation: DeregistrationDerivationSchema.optional(),
    degraded: EventStreamDegradedSchema.nullable().optional(),
  })
  .strict()
  .describe(
    "Per-subnet neuron-deregistration activity over a window (#5719). Zeroed card (0 counts) on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/deregistrations.",
  );
export type SubnetDeregistrationsArtifact = z.infer<
  typeof SubnetDeregistrationsArtifactSchema
>;

export const SubnetRegistrationsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_registrants: z.int().min(0),
    registrations: z.int().min(0),
    registrations_per_registrant: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetRegistrationsArtifact = z.infer<
  typeof SubnetRegistrationsArtifactSchema
>;

export const SubnetServingArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    window: ActivityWindowSchema,
    observed_at: z.iso.datetime().nullable(),
    distinct_servers: z.int().min(0),
    announcements: z.int().min(0),
    announcements_per_server: z.number().min(0).nullable(),
  })
  .strict();
export type SubnetServingArtifact = z.infer<typeof SubnetServingArtifactSchema>;
