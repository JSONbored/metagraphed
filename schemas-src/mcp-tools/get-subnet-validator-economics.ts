// MCP tool contract for get_subnet_validator_economics (#9323, #9327) — the agent-facing
// twin of GET /api/v1/subnets/{netuid}/validator-economics.
//
// The output is deliberately `.passthrough()` on the artifact: the REST payload carries
// `field_sources`, which the tool returns verbatim so an agent can tell a derived floor
// from a measured hyperparameter without a second call.
import { z } from "zod";
import {
  SubnetValidatorEconomicsArtifactSchema,
  ValidatorEconomicsRankingArtifactSchema,
  SubnetValidatorEconomicsHistoryArtifactSchema,
} from "../routes/validator-economics.ts";

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

// list_validator_economics (#9324) — the cross-subnet ranking. The MCP tool is as
// much the point of that issue as the REST route: it turns "find me a subnet worth
// validating on" into a single agent call.
export const ListValidatorEconomicsInputSchema = z
  .object({
    sort: z.string().optional(),
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    emission_gate_open: z.boolean().optional(),
    cap_binding: z.boolean().optional(),
  })
  .strict();
export type ListValidatorEconomicsInput = z.infer<
  typeof ListValidatorEconomicsInputSchema
>;

export const ListValidatorEconomicsOutputSchema =
  ValidatorEconomicsRankingArtifactSchema.passthrough();
export type ListValidatorEconomicsOutput = z.infer<
  typeof ListValidatorEconomicsOutputSchema
>;

// get_subnet_validator_economics_history (#9326).
export const GetSubnetValidatorEconomicsHistoryInputSchema = z
  .object({
    netuid: z.int().min(0),
    window: z.string().optional(),
  })
  .strict();
export type GetSubnetValidatorEconomicsHistoryInput = z.infer<
  typeof GetSubnetValidatorEconomicsHistoryInputSchema
>;

export const GetSubnetValidatorEconomicsHistoryOutputSchema =
  SubnetValidatorEconomicsHistoryArtifactSchema.passthrough();
