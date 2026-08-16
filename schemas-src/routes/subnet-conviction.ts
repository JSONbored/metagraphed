// GET /api/v1/subnets/{netuid}/conviction (types-epic B batch 2, #8056).
// Live subnet_locks-tier + live-RPC rates -- no static file. Modeled from
// src/subnet-conviction.ts's buildSubnetConviction(), cross-checked against
// the hand-edited SubnetConvictionArtifact/SubnetConvictionEntry components
// it replaces. No query params (verified: the DATA_API route reads only the
// netuid path segment).
import { z } from "zod";
import { EventStreamDegradedSchema } from "./event-stream-honesty.ts";
import { ChainU64Schema, FieldSourcesSchema } from "../shared.ts";

const SubnetConvictionEntrySchema = z
  .object({
    hotkey: z.string().optional(),
    is_owner: z.boolean().optional(),
    locked_mass: z.number().optional(),
    conviction: z.number().optional(),
  })
  .strict();

export const SubnetConvictionArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0).max(65535),
    queried_at_block: z.int().nullable().optional(),
    unlock_rate: ChainU64Schema.nullable().optional(),
    maturity_rate: ChainU64Schema.nullable().optional(),
    king: z.string().nullable().optional(),
    count: z.int().min(0),
    leaderboard: z.array(SubnetConvictionEntrySchema),
    // #9108. Every leaderboard row is an extrapolation to `queried_at_block`,
    // not a reading at it -- this is where the response says so.
    field_sources: FieldSourcesSchema,
    degraded: EventStreamDegradedSchema.nullable()
      .optional()
      .describe(
        "Present ONLY when the tier could not answer. All three surfaces publish the SAME marked empty for this route (#11423); an empty result WITHOUT it is a measurement.",
      ),
  })
  .strict()
  .describe(
    "Live per-subnet conviction leaderboard -- who currently holds the most rolled conviction, rolled forward from a periodically-captured snapshot using the current live-queried unlock_rate/maturity_rate. Mirrors GET /api/v1/subnets/{netuid}/conviction.",
  );
export type SubnetConvictionArtifact = z.infer<
  typeof SubnetConvictionArtifactSchema
>;
