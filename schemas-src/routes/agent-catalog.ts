// GET /api/v1/agent-catalog, /api/v1/agent-catalog/{netuid},
// /api/v1/agent-resources (types-epic B batch 10, #8064).
//
// AgentReadinessBlocker: batch 8 (#8062, merged concurrently) independently
// modeled and registered this exact shape in schemas-src/routes/coverage.ts
// (CoverageDepthRow.top_gaps[] -- verified field-for-field identical,
// including the severity enum's 3 values) -- reused by import here rather
// than duplicated. AgentReadinessStatus is registered -- not because
// anything still $refs it by name, but because
// scripts/validate-schema-enums.ts hardcodes a property-enum lookup against
// it (`comparePropertyEnum("AgentReadinessStatus", "status", ...)` and
// `"blocker_level"`), which requires it to stay a real named
// components.schemas entry rather than being inlined -- caught by running
// the full validate suite, not by the $ref-grep test alone.
// AgentServiceSchemaSource/AgentServiceFixtureStatus/SurfaceFixtureReference
// are each referenced only by this batch's own components -- modeled locally,
// not registered.
//
// Bucket (b) findings, verified against scripts/build-artifacts.ts's real
// inline assembly (no isolated pure builder exists for any of these 3 --
// same situation as BuildSummaryArtifact elsewhere in this batch):
// - AgentCatalogArtifact.subnets[] always carries `native_name` and
//   `example_count`, neither declared in the hand-edited schema.
// - AgentCatalogSubnetArtifact always carries `example_count`/`examples[]`,
//   and each services[] entry always carries `auth_schemes`/`auth`/`snippets`
//   -- none declared (tests/artifacts.test.ts already asserts example_count/
//   examples[] as a stable contract field, not incidental build noise).
// - AgentResourcesArtifact.summary is always exactly {subnet_count,
//   callable_service_count} despite additionalProperties:true -- tightened
//   to .strict() here.
import { z } from "zod";
import {
  ArtifactBaseSchema,
  ContentHashSchema,
  PublishedAtSchema,
} from "../envelope.ts";
import { IntegrationReadinessSchema } from "./subnet-profile.ts";
import { AgentReadinessBlockerSchema } from "./coverage.ts";
import { AuthSchema } from "./subnet-detail.ts";

export const AgentReadinessStatusSchema = z
  .object({
    status: z.enum([
      "callable",
      "base-layer",
      "candidate",
      "needs-evidence",
      "blocked",
    ]),
    blocker_level: z.enum([
      "none",
      "hard-blocked",
      "needs-review",
      "missing-data",
    ]),
    blockers: z.array(AgentReadinessBlockerSchema),
    missing_fields: z.array(z.string()),
    // Only ever set by the live overlay (src/health-serving.ts's
    // overlayCatalogDetail) -- never present in the static build.
    readiness_verified: z.boolean().optional(),
  })
  .strict()
  .describe(
    "Agent-facing readiness status and blocker taxonomy for one subnet.",
  );

const AgentServiceHealthSchema = z
  .object({
    status: z.string().optional(),
    classification: z.string().nullable().optional(),
    latency_ms: z.int().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    last_checked: z.string().nullable().optional(),
    stale: z.boolean().optional(),
    observed_by: z.string().optional(),
    monitoring_status: z.string().nullable().optional(),
  })
  .strict();

const AgentServiceEligibilitySchema = z
  .object({
    callable: z.boolean().optional(),
    reasons: z.array(z.string()).optional(),
    live_status: z.string().optional(),
  })
  .strict();

export const AgentCatalogSubnetEntrySchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string().optional(),
    name: z.string().optional(),
    native_name: z.string().nullable().optional(),
    categories: z.array(z.string()).optional(),
    subnet_type: z.string().nullable().optional(),
    completeness_score: z.number().nullable().optional(),
    integration_readiness: z.int().min(0).max(100).optional(),
    readiness: IntegrationReadinessSchema.optional(),
    agent_readiness: AgentReadinessStatusSchema.optional(),
    service_count: z.int().min(0),
    callable_count: z.int().min(0).optional(),
    service_kinds: z.array(z.string()).optional(),
    example_count: z.int().min(0).optional(),
    base_url: z.string().nullable().optional(),
    health: z.string().optional(),
    previously_known_as: z.array(z.string()).optional(),
  })
  .strict();

const AgentCatalogBlockedSubnetEntrySchema = z
  .object({
    netuid: z.int().min(0),
    slug: z.string().optional(),
    name: z.string().optional(),
    categories: z.array(z.string()).optional(),
    subnet_type: z.string().nullable().optional(),
    completeness_score: z.number().nullable().optional(),
    integration_readiness: z.int().min(0).max(100).optional(),
    readiness_tier: z.string().optional(),
    service_count: z.int().min(0).optional(),
    callable_count: z.int().min(0).optional(),
    agent_readiness: AgentReadinessStatusSchema,
  })
  .strict();

export const AgentCatalogArtifactSchema = ArtifactBaseSchema.extend({
  // The build stamps both on this artifact and this schema declared neither
  // (#10790) -- the omission the undeclared-field report found.
  content_hash: ContentHashSchema,
  published_at: PublishedAtSchema,
  total_subnet_count: z.int().min(0).optional(),
  subnet_count: z.int().min(0),
  blocked_subnet_count: z.int().min(0).optional(),
  callable_service_count: z.int().min(0).optional(),
  // #9800. Was `z.record(z.string(), z.unknown())`. Each member is a genuine
  // dynamic-key tally -- the keys are the blocker vocabulary itself -- so these
  // are typed RECORDS rather than fixed property lists: a new blocker code adds
  // a key without changing the contract, which is the point.
  blocker_summary: z
    .object({
      by_code: z.record(z.string(), z.int().min(0)).optional(),
      by_level: z.record(z.string(), z.int().min(0)).optional(),
      by_severity: z.record(z.string(), z.int().min(0)).optional(),
      by_status: z.record(z.string(), z.int().min(0)).optional(),
    })
    .strict()
    .optional(),
  subnets: z.array(AgentCatalogSubnetEntrySchema),
  blocked_subnets: z.array(AgentCatalogBlockedSubnetEntrySchema).optional(),
});
export type AgentCatalogArtifact = z.infer<typeof AgentCatalogArtifactSchema>;

const AgentServiceSchemaSourceSchema = z
  .object({
    surface_id: z.string(),
    match: z.enum(["surface-id", "schema-url", "same-origin-openapi"]),
    url: z.string().nullable(),
    artifact: z.string().nullable(),
    status: z.string().nullable(),
    observed_at: z.string().nullable(),
    hash: z.string().nullable(),
  })
  .strict();

const AgentServiceFixtureStatusSchema = z
  .object({
    status: z.enum([
      "available",
      "missing",
      "capture-failed",
      "auth-required",
      "non-get",
      "unsupported-kind",
    ]),
    reason: z.string().nullable(),
    artifact_path: z.string().nullable(),
    captured_at: z.string().nullable(),
  })
  .strict();

const SurfaceFixtureReferenceSchema = z
  .object({
    captured_at: z.string().nullable().optional(),
    request: z
      .object({ method: z.string(), url: z.string().nullable() })
      .strict(),
    response: z
      .object({
        status: z.int().nullable(),
        content_type: z.string().nullable().optional(),
      })
      .strict(),
    artifact_path: z.string(),
  })
  .strict();

export const AgentCatalogServiceSchema = z
  .object({
    surface_id: z.string(),
    kind: z.string(),
    capability: z.string().optional(),
    description: z.string().nullable().optional(),
    base_url: z.string(),
    provider: z.string().nullable().optional(),
    authority: z.string().nullable().optional(),
    auth_required: z.boolean().optional(),
    auth_schemes: z.array(z.string()).optional(),
    // ONE VOCABULARY (#10790): the same `AuthSchema` /api/v1/subnets/{netuid}
    // publishes. This was a second, narrower copy of it -- `.passthrough()`,
    // missing `body_envelope` and `token_url` -- which served `body_envelope`
    // on eight services while declaring nothing about it.
    auth: AuthSchema,
    snippets: z
      .object({
        curl: z.string().optional(),
        python: z.string().optional(),
        typescript: z.string().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    schema_url: z.string().nullable().optional(),
    schema_status: z.string().nullable().optional(),
    schema_artifact: z.string().nullable().optional(),
    schema_source: AgentServiceSchemaSourceSchema.nullable().optional(),
    health: AgentServiceHealthSchema.optional(),
    eligibility: AgentServiceEligibilitySchema.optional(),
    fixture: SurfaceFixtureReferenceSchema.optional(),
    fixture_status: AgentServiceFixtureStatusSchema.optional(),
  })
  .strict();

const AgentCatalogExampleSchema = z
  .object({
    surface_id: z.string(),
    name: z.string().optional(),
    url: z.string(),
    provider: z.string().optional(),
    authority: z.string().optional(),
  })
  .strict();

export const AgentCatalogSubnetArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  slug: z.string().optional(),
  name: z.string().optional(),
  previously_known_as: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  subnet_type: z.string().nullable().optional(),
  completeness_score: z.number().nullable().optional(),
  integration_readiness: z.int().min(0).max(100).optional(),
  readiness: IntegrationReadinessSchema.optional(),
  agent_readiness: AgentReadinessStatusSchema.optional(),
  service_count: z.int().min(0),
  services: z.array(AgentCatalogServiceSchema),
  example_count: z.int().min(0).optional(),
  examples: z.array(AgentCatalogExampleSchema).optional(),
});
export type AgentCatalogSubnetArtifact = z.infer<
  typeof AgentCatalogSubnetArtifactSchema
>;

export const AgentResourcesArtifactSchema = ArtifactBaseSchema.extend({
  content_hash: ContentHashSchema,
  published_at: PublishedAtSchema,
  summary: z
    .object({
      subnet_count: z.int().min(0),
      callable_service_count: z.int().min(0),
    })
    .strict()
    .optional(),
  copyable_agent: z
    .object({
      title: z.string().optional(),
      url: z.url(),
      description: z.string().optional(),
    })
    .strict(),
  mcp: z
    .object({
      endpoint: z.url(),
      transport: z.string().optional(),
      install: z.string(),
      server_card: z.url().optional(),
      tools: z.array(
        z
          .object({ name: z.string(), title: z.string().nullable().optional() })
          .strict(),
      ),
    })
    .strict(),
  resources: z.array(
    z
      .object({
        id: z.string(),
        title: z.string(),
        kind: z.string().optional(),
        url: z.url(),
        // The command that installs this resource, where one exists (the MCP
        // server and the agent skill). Served since the catalog gained them
        // and declared nowhere (#10790) -- on the artifact whose entire job is
        // telling an agent how to reach us.
        install: z
          .string()
          .optional()
          .describe(
            "Copy-pasteable install command, for the resources that have one.",
          ),
      })
      .strict(),
  ),
});
export type AgentResourcesArtifact = z.infer<
  typeof AgentResourcesArtifactSchema
>;
