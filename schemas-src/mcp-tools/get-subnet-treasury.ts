// get_subnet_treasury (#10933).
//
// The output IS the route's artifact schema by identity — never re-modelled.
// The route takes no query parameters, so the input is the netuid alone.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { SubnetTreasuryArtifactSchema } from "../routes/treasury.ts";

export const GetSubnetTreasuryInputSchema = z
  .object({ netuid: netuidSchema() })
  .strict();

export const GetSubnetTreasuryOutputSchema = SubnetTreasuryArtifactSchema;
