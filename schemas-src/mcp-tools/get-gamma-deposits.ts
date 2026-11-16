import { z } from "zod";
import { GammaDepositsArtifactSchema } from "../routes/gamma-deposits.ts";

export const GetGammaDepositsInputSchema = z.object({}).strict();

export const GetGammaDepositsOutputSchema = GammaDepositsArtifactSchema;
