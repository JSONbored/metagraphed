import { z } from "zod";
import { SubnetPriceShareCompositionArtifactSchema } from "../routes/subnet-price-share-composition.ts";

export const GetSubnetPriceShareCompositionInputSchema = z.object({}).strict();
export const GetSubnetPriceShareCompositionOutputSchema = SubnetPriceShareCompositionArtifactSchema;
