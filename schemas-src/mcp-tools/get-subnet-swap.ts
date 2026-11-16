import { z } from "zod";
import { SubnetSwapArtifactSchema } from "../routes/subnet-swap.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetSwapInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetSwapOutputSchema = SubnetSwapArtifactSchema;
