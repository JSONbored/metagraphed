import { z } from "zod";
import { SubnetServicesArtifactSchema } from "../routes/subnet-services.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetServicesInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetServicesOutputSchema = SubnetServicesArtifactSchema;
