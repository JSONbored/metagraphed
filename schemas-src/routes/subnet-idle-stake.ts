// GET /api/v1/subnets/{netuid}/idle-stake (types-epic B batch 1, #8055).
// Live neurons-tier scorecard -- no static file. Modeled from
// src/subnet-idle-stake.ts's buildSubnetIdleStake() (every field always
// set), cross-checked against the hand-edited SubnetIdleStakeArtifact
// component it replaces.
import { z } from "zod";

export const SubnetIdleStakeArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    captured_at: z.string().nullable().optional(),
    neuron_count: z.int().min(0),
    idle_neuron_count: z.int().min(0),
    idle_stake_alpha: z.number().min(0),
  })
  .passthrough()
  .describe(
    "Per-subnet idle-stake scorecard (#7172). Zeroed card on a cold/absent store. Mirrors GET /api/v1/subnets/{netuid}/idle-stake.",
  );
export type SubnetIdleStakeArtifact = z.infer<
  typeof SubnetIdleStakeArtifactSchema
>;
