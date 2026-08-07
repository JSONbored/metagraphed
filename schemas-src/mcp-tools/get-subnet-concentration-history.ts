// MCP tool `get_subnet_concentration_history` (types-epic E batch 3,
// #8066). Mirrors GET /api/v1/subnets/{netuid}/concentration/history, which
// is not one of schemas-src/routes/'s covered pilot routes -- no existing
// Zod schema to reuse. Modeled fresh, shallow, from the hand-written
// literal it replaces.
import { z } from "zod";
import { SubnetConcentrationHistoryArtifactSchema } from "../routes/subnet-concentration.ts";
import { netuidSchema, windowSchema } from "./shared.ts";

const CONCENTRATION_HISTORY_WINDOWS = ["7d", "30d", "90d"] as const;

export const GetSubnetConcentrationHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    window: windowSchema(CONCENTRATION_HISTORY_WINDOWS).optional(),
  })
  .strict();
export type GetSubnetConcentrationHistoryInput = z.infer<
  typeof GetSubnetConcentrationHistoryInputSchema
>;

// DERIVED, NOT COPIED (#9796). The copy typed every metric this tool
// reports -- stake_gini, the Nakamoto coefficients, the top-10% shares --
// as `z.unknown()`, which is weaker than an open object: it declares that
// nothing at all is known about the value. The route models each one.
export const GetSubnetConcentrationHistoryOutputSchema =
  SubnetConcentrationHistoryArtifactSchema;
export type GetSubnetConcentrationHistoryOutput = z.infer<
  typeof GetSubnetConcentrationHistoryOutputSchema
>;
