import { z } from "zod";
import { ValidatorBasketsArtifactSchema } from "../routes/validator-baskets.ts";

export const GetValidatorBasketsInputSchema = z.object({}).strict();

export const GetValidatorBasketsOutputSchema = ValidatorBasketsArtifactSchema;
