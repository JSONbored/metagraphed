// GET /api/v1/chain/emission-splits (MET-7365, runtime spec 497). Every
// subnet's current emission split and lifecycle state in one response, from
// state.subnet_emission_splits and state.subnet_lifecycle_states (migration
// 0060): the set a reader needs to see which subnets left the runtime's
// default 18/41/41 split, and where each one's emission goes.
import { z } from "zod";
import {
  EmissionSlotsSchema,
  EmissionSplitSchema,
  SubnetLifecycleStateSchema,
} from "./subnet-emission-split.ts";

export const ChainEmissionSplitEntrySchema = EmissionSplitSchema.extend({
  netuid: z.int().min(0).max(65535),
  stage: SubnetLifecycleStateSchema.shape.stage,
  epoch_consensus: SubnetLifecycleStateSchema.shape.epoch_consensus,
  created_via_lease: SubnetLifecycleStateSchema.shape.created_via_lease,
})
  .strict()
  .describe(
    "One subnet's current split, with its current lifecycle state beside it.",
  );

export const ChainEmissionSplitsArtifactSchema = z
  .object({
    schema_version: z.int(),
    observed_block: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The newest finalized block the capture read every subnet at. Null when no capture has been observed: the subnet list is then empty and every count null.",
      ),
    observed_at: z
      .string()
      .nullable()
      .describe("When that capture ran, as an ISO timestamp."),
    subnet_count: z
      .int()
      .min(0)
      .nullable()
      .describe("How many subnets the chain held at the observed block."),
    custom_count: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "How many of them carry a split other than the runtime's default (owner 18%, validators 41%, miners the rest, no gamma shares).",
      ),
    gamma_share_count: z
      .int()
      .min(0)
      .nullable()
      .describe("How many of them route any part of their emission to gamma."),
    default_split: EmissionSlotsSchema.describe(
      "The runtime's default split, for comparison: InitialSubnetOwnerCut (11796/65535) for the owner, half the rest for validators, and the remainder for miners.",
    ),
    subnets: z
      .array(ChainEmissionSplitEntrySchema)
      .describe("Every subnet the chain held, ascending by netuid."),
  })
  .strict()
  .describe(
    "Every subnet's current emission split and lifecycle state from chain storage (runtime spec 497). Mirrors GET /api/v1/chain/emission-splits.",
  );
