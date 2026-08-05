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
import { limitSchema, netuidSchema, offsetSchema } from "./shared.ts";
import { VALIDATOR_ECONOMICS_LIMIT_MAX } from "../../src/route-limits.ts";
import {
  VALIDATOR_ECONOMICS_HISTORY_WINDOWS,
  VALIDATOR_ECONOMICS_SORTS,
} from "../../src/validator-economics.ts";

export const GetSubnetValidatorEconomicsInputSchema = z
  .object({
    netuid: netuidSchema(),
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
    // An enum, not a free string. The description already named all five keys,
    // and REST rejected anything else with a 400 — but MCP took any string and SILENTLY
    // ranked by the default, echoing that default back as `sort`. A model that guessed
    // got a plausible list answering a question nobody asked. Read from the same
    // constant the ranking and the REST validator use.
    sort: z.enum(VALIDATOR_ECONOMICS_SORTS).optional(),
    // Was unbounded while the mirrored route rejected anything over 512.
    limit: limitSchema(VALIDATOR_ECONOMICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
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
    netuid: netuidSchema(),
    // The one window parameter of 55 that was not an enum. Its sibling
    // get_subnet_burn_history already declared one, so a model reading the two
    // together had no way to know this was the same kind of closed set.
    window: z
      .enum(
        Object.keys(VALIDATOR_ECONOMICS_HISTORY_WINDOWS) as [
          string,
          ...string[],
        ],
      )
      .optional(),
  })
  .strict();
export type GetSubnetValidatorEconomicsHistoryInput = z.infer<
  typeof GetSubnetValidatorEconomicsHistoryInputSchema
>;

export const GetSubnetValidatorEconomicsHistoryOutputSchema =
  SubnetValidatorEconomicsHistoryArtifactSchema.passthrough();
