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
//   - SurfaceKind / Authority / Classification / BittensorNetwork /
//     HealthStatus / EndpointLayer / ProbeConfig / EndpointMonitoringPolicy /
//     EndpointScoreReason / VerificationResult / SourceTier / CurationLevel /
//     ReviewState -- enum and sub-object leaves used BY the pilot shapes
//     above. Registering them is REQUIRED, not optional: z.toJSONSchema()
//     with reused:"inline" only keeps a schema as its own named component
//     when it's a separately registered root; leaving these unregistered
//     silently inlined them everywhere they're used and deleted their
//     standalone `components.schemas.*` entries from the public contract --
//     a real regression caught in PR #8054 review (anyone importing
//     `components["schemas"]["SurfaceKind"]` etc. from the generated client
//     types would have lost that export). Registering them restores the
//     named refs exactly as the hand-edited schemas had them.
//
// Deliberately NOT registered (left to inline where used, verified safe by
// the types-epic B research pass): SubnetEconomics -- referenced only by the
// two now-replaced components (EconomicsArtifact, SubnetDetailArtifact), so
// inlining it into both costs nothing but a little document size, and it was
// the SAME safe-to-drop component recommended for deletion at the JSON layer.
// This is the ONLY intentionally-dropped component name in this file; every
// other component the hand-edited schemas named standalone is registered
// above, name for name.
import { z } from "zod";
import {
  BittensorNetworkSchema,
  CurationLevelSchema,
  HealthStatusSchema,
  PartnershipMetadataSchema,
} from "./shared.ts";
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
  SurfaceKindSchema,
  SourceTierSchema,
  ClassificationSchema,
  AuthoritySchema,
  EndpointLayerSchema,
  ProbeConfigSchema,
  EndpointMonitoringPolicySchema,
  EndpointScoreReasonSchema,
  VerificationResultSchema,
  ReviewStateSchema,
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
register(SurfaceKindSchema, "SurfaceKind");
register(SourceTierSchema, "SourceTier");
register(ClassificationSchema, "Classification");
register(AuthoritySchema, "Authority");
register(EndpointLayerSchema, "EndpointLayer");
register(ProbeConfigSchema, "ProbeConfig");
register(EndpointMonitoringPolicySchema, "EndpointMonitoringPolicy");
register(EndpointScoreReasonSchema, "EndpointScoreReason");
register(VerificationResultSchema, "VerificationResult");
register(ReviewStateSchema, "ReviewState");
register(BittensorNetworkSchema, "BittensorNetwork");
register(HealthStatusSchema, "HealthStatus");
register(CurationLevelSchema, "CurationLevel");

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
  "SurfaceKind",
  "SourceTier",
  "Classification",
  "Authority",
  "EndpointLayer",
  "ProbeConfig",
  "EndpointMonitoringPolicy",
  "EndpointScoreReason",
  "VerificationResult",
  "ReviewState",
  "BittensorNetwork",
  "HealthStatus",
  "CurationLevel",
] as const;

// SubnetEconomics has no registry entry (see header) but its hand-edited
// component key must still be dropped -- nothing references it by name
// anymore once EconomicsArtifact/SubnetDetailArtifact are Zod-owned.
export const OPENAPI_ZOD_ORPHANED_COMPONENT_NAMES = [
  "SubnetEconomics",
] as const;
