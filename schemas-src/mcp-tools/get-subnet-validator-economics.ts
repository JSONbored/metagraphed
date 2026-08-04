// MCP tool contract for get_subnet_validator_economics (#9323, #9327) — the agent-facing
// twin of GET /api/v1/subnets/{netuid}/validator-economics.
//
// The output is deliberately `.passthrough()` on the artifact: the REST payload carries
// `field_sources`, which the tool returns verbatim so an agent can tell a derived floor
// from a measured hyperparameter without a second call.
import { z } from "zod";
import { SubnetValidatorEconomicsArtifactSchema } from "../routes/validator-economics.ts";

export const GetSubnetValidatorEconomicsInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetValidatorEconomicsInput = z.infer<
  typeof GetSubnetValidatorEconomicsInputSchema
>;

export const GetSubnetValidatorEconomicsOutputSchema =
  SubnetValidatorEconomicsArtifactSchema.passthrough();
export type GetSubnetValidatorEconomicsOutput = z.infer<
  typeof GetSubnetValidatorEconomicsOutputSchema
>;
