import { z } from "zod";
import { SubnetGammaArtifactSchema } from "../routes/subnet-gamma.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetGammaInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetGammaOutputSchema = SubnetGammaArtifactSchema;
