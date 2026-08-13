// get_subnet_cost_to_participate (#10932 phase 1).
//
// The output IS the route's artifact schema by identity — never re-modelled.
// The route takes no query parameters, so the input is the netuid alone.
import { z } from "zod";
import { netuidSchema } from "./shared.ts";
import { SubnetCostToParticipateArtifactSchema } from "../routes/cost-to-participate.ts";

export const GetSubnetCostToParticipateInputSchema = z
  .object({ netuid: netuidSchema() })
  .strict();

export const GetSubnetCostToParticipateOutputSchema =
  SubnetCostToParticipateArtifactSchema;
