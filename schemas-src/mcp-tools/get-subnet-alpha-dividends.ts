import { z } from "zod";
import { SubnetAlphaDividendsArtifactSchema } from "../routes/subnet-alpha-dividends.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetAlphaDividendsInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();

export const GetSubnetAlphaDividendsOutputSchema =
  SubnetAlphaDividendsArtifactSchema;
