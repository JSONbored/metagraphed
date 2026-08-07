// MCP tool `get_subnet_concentration` (types-epic E batch 2, #8065). Mirrors
// GET /api/v1/subnets/{netuid}/concentration.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). This file's header used to say
// the route was "not one of schemas-src/routes/'s covered pilot routes -- no
// existing Zod schema to reuse", and it modelled the response "fresh, shallow"
// instead. SubnetConcentrationArtifactSchema now covers it, and the shallow
// copy was publishing `stake`, `emission`, `entity_stake`, `entity_emission`
// and `validator_stake` as bare open objects -- five of this tool's schema
// sites saying nothing at all, on a tool whose entire purpose is those five
// distributions.
//
// Verified against production before the switch: the live tool's response
// satisfies this schema. That check matters because deriving is a TIGHTENING --
// the route schema is stricter than the copy was.
import { z } from "zod";
import { SubnetConcentrationArtifactSchema } from "../routes/subnet-concentration.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetConcentrationInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetConcentrationInput = z.infer<
  typeof GetSubnetConcentrationInputSchema
>;

export const GetSubnetConcentrationOutputSchema =
  SubnetConcentrationArtifactSchema;
export type GetSubnetConcentrationOutput = z.infer<
  typeof GetSubnetConcentrationOutputSchema
>;
