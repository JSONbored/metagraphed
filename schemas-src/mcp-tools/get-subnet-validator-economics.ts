// MCP tools `get_subnet_validator_economics_history`,
// `list_validator_economics`, `get_subnet_validator_economics`.
// Mirror GET /api/v1/subnets/{netuid}/validator-economics/history, GET
// /api/v1/validators/economics, GET
// /api/v1/subnets/{netuid}/validator-economics.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  SubnetValidatorEconomicsArtifactSchema,
  ValidatorEconomicsRankingArtifactSchema,
  SubnetValidatorEconomicsHistoryArtifactSchema,
} from "../routes/validator-economics.ts";
import { limitSchema, netuidSchema, sortSchema } from "./shared.ts";
import {
  VALIDATOR_ECONOMICS_LIMIT_DEFAULT,
  VALIDATOR_ECONOMICS_LIMIT_MAX,
} from "../../src/route-limits.ts";
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
  SubnetValidatorEconomicsArtifactSchema;
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
    sort: sortSchema(VALIDATOR_ECONOMICS_SORTS).optional(),
    // Was unbounded while the mirrored route rejected anything over 512.
    limit: limitSchema(
      VALIDATOR_ECONOMICS_LIMIT_MAX,
      VALIDATOR_ECONOMICS_LIMIT_DEFAULT,
    ).optional(),
    // The route caps `offset` at VALIDATOR_ECONOMICS_LIMIT_MAX, not at the
    // generic MAX_OFFSET offsetSchema() carries -- this ranking is bounded by
    // the subnet count, so paging past it seeks nothing. The tool advertised
    // 1,000,000 (#10131).
    offset: z
      .int()
      .min(0)
      .max(VALIDATOR_ECONOMICS_LIMIT_MAX)
      .describe(
        `Rows to skip before the first returned row (0-${VALIDATOR_ECONOMICS_LIMIT_MAX}).`,
      )
      .meta({ examples: [0] })
      .optional(),
    emission_gate_open: z
      .boolean()
      .optional()
      .describe(
        "Restrict to subnets whose emission gate is open (`true`) or closed (`false`).",
      )
      .meta({ examples: [true] }),
    cap_binding: z
      .boolean()
      .optional()
      .describe(
        "Restrict to subnets where the validator cap is actually binding (`true`).",
      )
      .meta({ examples: [true] }),
  })
  .strict();
export type ListValidatorEconomicsInput = z.infer<
  typeof ListValidatorEconomicsInputSchema
>;

export const ListValidatorEconomicsOutputSchema =
  ValidatorEconomicsRankingArtifactSchema;
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
      .optional()
      .describe(
        "Trailing time window to aggregate over, ending at the latest data point rather than a calendar boundary. Options are per-tool; see this parameter's enum.",
      )
      .meta({
        examples: [Object.keys(VALIDATOR_ECONOMICS_HISTORY_WINDOWS)[0]],
      }),
  })
  .strict();
export type GetSubnetValidatorEconomicsHistoryInput = z.infer<
  typeof GetSubnetValidatorEconomicsHistoryInputSchema
>;

export const GetSubnetValidatorEconomicsHistoryOutputSchema =
  SubnetValidatorEconomicsHistoryArtifactSchema;
