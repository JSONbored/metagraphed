import { z } from "zod";
import { SubnetLimitOrdersArtifactSchema } from "../routes/subnet-limit-orders.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetLimitOrdersInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetLimitOrdersOutputSchema = SubnetLimitOrdersArtifactSchema;
