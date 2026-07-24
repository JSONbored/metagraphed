// Component-name registry for the OpenAPI generator (types-epic B, #7860).
//
// Each entry here becomes a NAMED entry in public/metagraph/openapi.json's
// components.schemas, at the id given -- these ids are load-bearing: they
// must match the names schemaRefForArtifactPath() and the hand-edited
// schemas/components/*.schema.json files already use, or downstream
// consumers (src/contracts.ts's route wiring, packages/client's generated
// types, other still-hand-edited components that $ref these by name) break.
//
// What's registered, and why:
//   - The 5 pilot routes' top-level artifact schemas (subnets/A#7859) --
//     required: schemaRefForArtifactPath binds each API route to exactly
//     this name.
//   - SubnetIndexEntry -- required: scripts/generate-client.ts hard-codes
//     `components["schemas"]["SubnetIndexEntry"]`; if z.toJSONSchema()
//     inlined it (the default with no registration), that named component
//     would disappear and the client SDK's generated types would fail to
//     compile.
//   - Surface / CandidateSurface / EndpointResource / Gaps /
//     CurationMetadata / PartnershipMetadata / HealthSubnetSummary -- these
//     are sub-shapes of the subnet-detail/health pilot responses that
//     schemas-src/routes/subnet-detail.ts and health.ts ALREADY modeled in
//     full (their own header comments: "no field was left as z.unknown()").
//     They're also referenced BY NAME from several other, still-hand-edited
//     components (SubnetProfileArtifact, SurfacesArtifact, CandidatesArtifact,
//     VerificationArtifact, EndpointsArtifact, HealthSubnetArtifact, etc.).
//     Registering them under their existing component names means those
//     untouched routes keep resolving to a real, validated schema (upgraded
//     for free) instead of either duplicating the shape inline or leaving a
//     dangling $ref. This is why the issue's "5 pilot routes" scope expands
//     to this specific set of names, not further.
//
// Deliberately NOT registered (left to inline where used, verified safe by
// the types-epic B research pass): SubnetEconomics -- referenced only by the
// two now-replaced components (EconomicsArtifact, SubnetDetailArtifact), so
// inlining it into both costs nothing but a little document size, and it was
// the SAME safe-to-drop component recommended for deletion at the JSON layer.
import { z } from "zod";
import { PartnershipMetadataSchema } from "./shared.ts";
import {
  SubnetsArtifactSchema,
  SubnetIndexEntrySchema,
} from "./routes/subnets.ts";
import {
  SubnetDetailArtifactSchema,
  SurfaceSchema,
  CandidateSurfaceSchema,
  EndpointResourceSchema,
  GapsSchema,
  CurationMetadataSchema,
} from "./routes/subnet-detail.ts";
import { EconomicsArtifactSchema } from "./routes/economics.ts";
import {
  HealthSummaryArtifactSchema,
  HealthSubnetSummarySchema,
} from "./routes/health.ts";
import { SubnetStakeQuoteArtifactSchema } from "./routes/stake-quote.ts";

export const openApiComponentRegistry = z.registry<{ id: string }>();

const register = (schema: z.ZodType, id: string) => {
  openApiComponentRegistry.add(schema, { id });
};

register(SubnetsArtifactSchema, "SubnetsArtifact");
register(SubnetIndexEntrySchema, "SubnetIndexEntry");
register(SubnetDetailArtifactSchema, "SubnetDetailArtifact");
register(SurfaceSchema, "Surface");
register(CandidateSurfaceSchema, "CandidateSurface");
register(EndpointResourceSchema, "EndpointResource");
register(GapsSchema, "Gaps");
register(CurationMetadataSchema, "CurationMetadata");
register(PartnershipMetadataSchema, "PartnershipMetadata");
register(EconomicsArtifactSchema, "EconomicsArtifact");
register(HealthSummaryArtifactSchema, "HealthSummaryArtifact");
register(HealthSubnetSummarySchema, "HealthSubnetSummary");
register(SubnetStakeQuoteArtifactSchema, "SubnetStakeQuoteArtifact");

// The component names this registry owns -- used by the generator to know
// which hand-edited schemas/components/*.schema.json keys to drop (they'd
// otherwise shadow the generated ones) and by the diff-audit script to know
// which components to compare.
export const OPENAPI_ZOD_COMPONENT_NAMES = [
  "SubnetsArtifact",
  "SubnetIndexEntry",
  "SubnetDetailArtifact",
  "Surface",
  "CandidateSurface",
  "EndpointResource",
  "Gaps",
  "CurationMetadata",
  "PartnershipMetadata",
  "EconomicsArtifact",
  "HealthSummaryArtifact",
  "HealthSubnetSummary",
  "SubnetStakeQuoteArtifact",
] as const;

// SubnetEconomics has no registry entry (see header) but its hand-edited
// component key must still be dropped -- nothing references it by name
// anymore once EconomicsArtifact/SubnetDetailArtifact are Zod-owned.
export const OPENAPI_ZOD_ORPHANED_COMPONENT_NAMES = [
  "SubnetEconomics",
] as const;
