import { z } from "zod";
import { ChainEmissionSplitsArtifactSchema } from "../routes/chain-emission-splits.ts";

export const GetChainEmissionSplitsInputSchema = z.object({}).strict();

export const GetChainEmissionSplitsOutputSchema =
  ChainEmissionSplitsArtifactSchema;
