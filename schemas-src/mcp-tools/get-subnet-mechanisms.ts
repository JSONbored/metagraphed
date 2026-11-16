import { z } from "zod";
import { SubnetMechanismsArtifactSchema } from "../routes/subnet-mechanisms.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetMechanismsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetMechanismsOutputSchema = SubnetMechanismsArtifactSchema;
