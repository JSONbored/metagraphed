// GET /api/v1, /api/v1/contracts, /api/v1/openapi.json, /api/v1/build,
// /api/v1/changelog (types-epic B batch 10, #8064) -- the API's self-
// describing meta routes. Modeled from src/contracts.ts's
// buildContractsArtifact()/buildApiIndexArtifact()/buildOpenApiArtifact(),
// scripts/changelog.ts's buildChangelog()/diffSubnets() (pure functions,
// called directly by the ground-truth tests), and build-summary.json's
// inline assembly in scripts/build-artifacts.ts (no isolated pure builder
// exists for it -- see BuildSummaryArtifactSchema's own header below).
//
// ArtifactContractEntry/ArtifactDiffEntry/ApiRoute/ApiQueryParameter/
// ResponseEnvelopeContract/ArtifactSizeBudget/CoverageDelta are each
// referenced only by this batch's own components (verified via repo-wide
// $ref grep) -- modeled locally below, not registered in
// schemas-src/openapi-registry.ts, same pattern as subnet-profile.ts's
// sub-schemas.
//
// Bucket (b) finding: the hand-edited ChangelogArtifact.subnets.added/removed
// declare `items: {type: "integer"}` (bare netuids), but scripts/changelog.ts's
// diffSubnets() has always returned `{netuid, name, slug}` objects for both --
// the hand-edited schema was stale from before diffSubnets() gained name/slug.
// Modeled here against the real (object) shape.
import { z } from "zod";
import { API_ROUTE_METHODS } from "../../src/contracts.ts";
import { ArtifactBaseSchema, CacheProfileSchema } from "../envelope.ts";

const ArtifactRetirementSchema = z
  .object({
    code: z.string(),
    http_status: z.int(),
    message: z.string(),
  })
  .strict()
  .nullable();

const ArtifactContractEntrySchema = z
  .object({
    content_type: z.string().optional(),
    retirement: ArtifactRetirementSchema.optional(),
    status: z.enum(["live", "retired"]),
    contract_version: z.string(),
    description: z.string().optional(),
    id: z.string(),
    path: z.string().regex(/^\/metagraph\//),
    schema_ref: z
      .string()
      .regex(/^#\/components\/schemas\/[A-Za-z0-9]+$/)
      .nullable(),
    storage_tier: z.enum(["dual", "git", "r2"]),
  })
  .strict();

const ArtifactDiffEntrySchema = z.union([
  z.string(),
  z
    .object({
      path: z.string(),
      hash: z.string().optional(),
      previous_hash: z.string().nullable().optional(),
    })
    .strict(),
]);

const ApiQueryParameterSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    schema: z.record(z.string(), z.unknown()),
  })
  .strict();

const ApiRouteSchema = z
  .object({
    artifact_path: z.string().regex(/^\/metagraph\//),
    cache: CacheProfileSchema,
    description: z.string(),
    id: z.string(),
    // DERIVED from API_ROUTES, not listed here. This was z.literal("GET")
    // until #9092 registered POST /api/v1/ask, and that literal is exactly the
    // "every route is a GET" assumption that kept the AI-native layer out of
    // the contract for as long as it did. Reading the methods the routes
    // actually declare means registering a route with a new verb cannot fail
    // against a second, staler list.
    method: z.enum(API_ROUTE_METHODS),
    path: z.string().regex(/^\/api\/v1/),
    public: z.literal(true),
    query_collection: z.string().nullable().optional(),
    query_filter_names: z.array(z.string()).optional(),
    // #8698: whether this route answers on networks other than mainnet, and
    // which. Optional so a consumer pinned to an older contract still
    // validates against this schema.
    mainnet_only: z.boolean().optional(),
    networks: z.array(z.string()).optional(),
    query_parameters: z.array(ApiQueryParameterSchema),
  })
  .strict();

const ResponseEnvelopeContractSchema = z
  .object({
    error_schema_ref: z.literal("#/components/schemas/ErrorEnvelope"),
    fields: z.array(z.enum(["ok", "data", "meta", "error"])),
    notes: z.string(),
    schema_version: z.literal(1),
    success_schema_ref: z.literal("#/components/schemas/SuccessEnvelope"),
  })
  .strict();

const ArtifactSizeBudgetSchema = z
  .object({
    path: z.string(),
    size_bytes: z.int().min(0),
    warn_bytes: z.int().min(0),
    fail_bytes: z.int().min(0),
    status: z.enum(["ok", "warn", "fail"]),
  })
  .strict();

const CoverageDeltaSchema = z
  .object({
    after: z.int().min(0),
    before: z.int().min(0),
    delta: z.int(),
  })
  .strict();

export const ContractsArtifactSchema = ArtifactBaseSchema.extend({
  artifacts: z.array(ArtifactContractEntrySchema),
  base_path: z.literal("/metagraph"),
  name: z.string(),
  openapi_url: z.literal("/metagraph/openapi.json"),
  primary_domain: z.literal("api.metagraph.sh"),
  status_domain: z.null(),
  type_definitions_url: z.literal("/metagraph/types.d.ts"),
});
export type ContractsArtifact = z.infer<typeof ContractsArtifactSchema>;

export const ApiIndexArtifactSchema = ArtifactBaseSchema.extend({
  artifact_contracts: z.array(ArtifactContractEntrySchema),
  base_path: z.literal("/api/v1"),
  openapi_url: z.literal("/api/v1/openapi.json"),
  primary_domain: z.literal("api.metagraph.sh"),
  response_envelope: ResponseEnvelopeContractSchema,
  routes: z.array(ApiRouteSchema),
  type_definitions_url: z.literal("/metagraph/types.d.ts"),
});
export type ApiIndexArtifact = z.infer<typeof ApiIndexArtifactSchema>;

// Not ArtifactBase-based -- the raw OpenAPI 3.1 document itself (info/paths/
// components), not a metagraphed artifact envelope. The hand-edited component
// deliberately stays loose (additionalProperties: true throughout) rather
// than modeling the full OpenAPI meta-schema; mirrored as-is here.
export const OpenApiArtifactSchema = z
  .object({
    openapi: z.literal("3.1.0"),
    info: z.record(z.string(), z.unknown()),
    servers: z.array(z.record(z.string(), z.unknown())).optional(),
    paths: z.record(z.string(), z.unknown()),
    components: z.record(z.string(), z.unknown()),
    "x-metagraphed": z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type OpenApiArtifact = z.infer<typeof OpenApiArtifactSchema>;

const SubnetDiffEntrySchema = z
  .object({
    netuid: z.int().min(0),
    name: z.string().nullable().optional(),
    slug: z.string().optional(),
  })
  .passthrough();

const SubnetRenameEntrySchema = z
  .object({
    netuid: z.int().min(0),
    before: z.string().nullable().optional(),
    after: z.string().nullable().optional(),
  })
  .passthrough();

export const ChangelogArtifactSchema = ArtifactBaseSchema.extend({
  artifacts: z
    .object({
      added: z.array(ArtifactDiffEntrySchema),
      modified: z.array(ArtifactDiffEntrySchema),
      removed: z.array(ArtifactDiffEntrySchema),
    })
    .strict(),
  source: z.literal("generated-artifact-diff"),
  subnets: z
    .object({
      added: z.array(SubnetDiffEntrySchema),
      removed: z.array(SubnetDiffEntrySchema),
      renamed: z.array(SubnetRenameEntrySchema),
    })
    .strict(),
  summary: z
    .object({
      artifact_added_count: z.int().min(0),
      artifact_modified_count: z.int().min(0),
      artifact_removed_count: z.int().min(0),
      coverage_delta: z
        .record(z.string(), CoverageDeltaSchema.nullable())
        .nullable(),
      netuid_added_count: z.int().min(0),
      netuid_removed_count: z.int().min(0),
      netuid_renamed_count: z.int().min(0),
    })
    .strict(),
});
export type ChangelogArtifact = z.infer<typeof ChangelogArtifactSchema>;

// No isolated pure builder: build-summary.json is assembled inline in
// scripts/build-artifacts.ts (a build script excluded from in-process
// coverage -- see vitest.config.ts's coverage.include comment), not via a
// separate function. Modeled from that inline object literal directly;
// stays .passthrough() (matching the hand-edited additionalProperties:true)
// since several observed real fields (coverage, public_contract,
// storage_tier_counts/_size_bytes, artifact_budget_summary) are themselves
// assembled by further helpers not traced field-by-field here.
export const BuildSummaryArtifactSchema = ArtifactBaseSchema.extend({
  published_at: z.string().nullable().optional(),
  adapter_count: z.int().min(0).optional(),
  artifact_count: z.int().min(0),
  artifact_size_bytes: z.int().min(0),
  full_artifact_count: z.int().min(0).optional(),
  full_artifact_size_bytes: z.int().min(0).optional(),
  storage_tier_counts: z.record(z.string(), z.int().min(0)).optional(),
  storage_tier_size_bytes: z.record(z.string(), z.int().min(0)).optional(),
  artifacts: z.array(z.record(z.string(), z.unknown())).optional(),
  artifact_budget_summary: z
    .object({
      fail_count: z.int().min(0),
      ok_count: z.int().min(0),
      warn_count: z.int().min(0),
    })
    .passthrough()
    .optional(),
  artifact_budgets: z.array(ArtifactSizeBudgetSchema).optional(),
  candidate_count: z.int().min(0).optional(),
  coverage: z.record(z.string(), z.unknown()).optional(),
  endpoint_count: z.int().min(0).optional(),
  profile_count: z.int().min(0).optional(),
  provider_count: z.int().min(0).optional(),
  subnet_count: z.int().min(0),
  surface_count: z.int().min(0),
  public_contract: z
    .object({ version: z.string(), url: z.string() })
    .passthrough()
    .optional(),
});
export type BuildSummaryArtifact = z.infer<typeof BuildSummaryArtifactSchema>;
