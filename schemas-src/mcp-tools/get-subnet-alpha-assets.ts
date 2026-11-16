import { z } from "zod";
import { SubnetAlphaAssetsArtifactSchema } from "../routes/subnet-alpha-assets.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetAlphaAssetsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetAlphaAssetsOutputSchema = SubnetAlphaAssetsArtifactSchema;
