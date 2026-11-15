import { z } from "zod";
import { PendingColdkeySwapsArtifactSchema } from "../routes/coldkey-swaps.ts";

export const GetPendingColdkeySwapsInputSchema = z.object({}).strict();

export const GetPendingColdkeySwapsOutputSchema =
  PendingColdkeySwapsArtifactSchema;
