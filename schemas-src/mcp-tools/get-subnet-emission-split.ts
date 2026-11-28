import { z } from "zod";
import { SubnetEmissionSplitArtifactSchema } from "../routes/subnet-emission-split.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetEmissionSplitInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetEmissionSplitOutputSchema =
  SubnetEmissionSplitArtifactSchema;
