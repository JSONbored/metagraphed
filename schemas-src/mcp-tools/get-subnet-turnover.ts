// MCP tool `get_subnet_turnover` (types-epic E batch 3, #8066). Mirrors GET
// /api/v1/subnets/{netuid}/turnover, which is not one of schemas-src/routes/'s
// covered pilot routes -- no existing Zod schema to reuse. Modeled fresh,
// shallow, from the hand-written literal it replaces. Window enum
// hardcoded from src/neuron-history.ts's SUBNET_TURNOVER_WINDOW_VALUES at the time of
// writing (mirrors the pilot batch's ECONOMICS_SORT_FIELDS precedent -- not
// cross-imported).
import { z } from "zod";
import { SubnetTurnoverArtifactSchema } from "../routes/subnet-turnover.ts";
import { netuidSchema, windowSchema } from "./shared.ts";
import { SUBNET_TURNOVER_WINDOW_VALUES } from "../routes/subnet-turnover.ts";

export const GetSubnetTurnoverInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(SUBNET_TURNOVER_WINDOW_VALUES).optional(),
    changes: z
      .boolean()
      .optional()
      .describe(
        "When true, return only entries that changed rather than every entry.",
      )
      .meta({ examples: [true] }),
  })
  .strict();
export type GetSubnetTurnoverInput = z.infer<
  typeof GetSubnetTurnoverInputSchema
>;

// DERIVED, NOT COPIED (#9796). The copy published the three change lists --
// validators_entered[], validators_exited[], uid_reassignments[] -- as bare
// open arrays, which is the whole answer this tool gives.
export const GetSubnetTurnoverOutputSchema = SubnetTurnoverArtifactSchema;
export type GetSubnetTurnoverOutput = z.infer<
  typeof GetSubnetTurnoverOutputSchema
>;
