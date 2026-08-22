// MCP tool `get_subnet_price_share_composition`.
// Mirrors GET /api/v1/chain/subnet-price-share-composition.
//
// No query arguments by design: the fixed 56-day, stable-cohort output is a
// visual and cache contract, not a free-form analytical query. A caller that
// needs a different range can use the broader economics history surfaces.
import { z } from "zod";
import { SubnetPriceShareCompositionArtifactSchema } from "../routes/subnet-price-share-composition.ts";

// The schemas are the contract; consumers read this shape through the
// generated OpenAPI types, so the usual `z.infer` aliases would be three
// exports nothing imports. Derive one inline (`z.infer<typeof …Schema>`) if a
// call site ever needs it.
export const GetSubnetPriceShareCompositionInputSchema = z.object({}).strict();

export const GetSubnetPriceShareCompositionOutputSchema =
  SubnetPriceShareCompositionArtifactSchema;
