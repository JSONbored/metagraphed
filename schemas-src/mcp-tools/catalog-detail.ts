// MCP tool `get_provider_detail`.
// Mirrors GET /api/v1/providers/{slug}.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_provider_detail: 2 bare `{"type":"object"}` sites.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  OpenArraySchema,
  OpenObjectSchema,
  netuidSchema,
  surfaceIdSchema,
} from "./shared.ts";
import { ProviderArtifactSchema } from "../routes/providers-rpc.ts";
import { AgentCatalogServiceSchema } from "../routes/agent-catalog.ts";

export const ListSubnetApisInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type ListSubnetApisInput = z.infer<typeof ListSubnetApisInputSchema>;

export const ListSubnetApisOutputSchema = z
  .object({
    netuid: netuidSchema(),
    service_count: z.int(),
    // Typed from the route's own AgentCatalogServiceSchema (#9797) -- the
    // 18-field callable-service record, including the eligibility/health/
    // fixture/snippets blocks an agent needs to decide whether it can call
    // this surface. This tool advertises no `fields`, so it is not partial.
    // Verified against production 2026-08-07.
    services: z.array(AgentCatalogServiceSchema),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type ListSubnetApisOutput = z.infer<typeof ListSubnetApisOutputSchema>;

export const GetApiSchemaInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
  })
  .strict();
export type GetApiSchemaInput = z.infer<typeof GetApiSchemaInputSchema>;

export const GetApiSchemaOutputSchema = z
  .object({
    surface_id: z.string(),
    kind: z.string().nullable().optional(),
    base_url: z.string().nullable().optional(),
    auth_required: z.boolean().nullable().optional(),
    auth_schemes: OpenArraySchema.optional(),
    drift_status: z.string().nullable().optional(),
    document: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetApiSchemaOutput = z.infer<typeof GetApiSchemaOutputSchema>;

export const GetFixtureInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
  })
  .strict();
export type GetFixtureInput = z.infer<typeof GetFixtureInputSchema>;

// The hand-written original declares only surface_id -- the actual fixture
// payload has many more fields, deliberately left undeclared (loose
// additionalProperties:true), not "improved" with a guessed shape here.
export const GetFixtureOutputSchema = z
  .object({
    surface_id: z.string(),
  })
  .passthrough();
export type GetFixtureOutput = z.infer<typeof GetFixtureOutputSchema>;

export const GetProviderDetailInputSchema = z
  .object({
    slug: z
      .string()
      .describe(
        "The registry slug — lowercase, hyphenated (`chutes`), not the display name. Slugs are stable across renames.",
      )
      .meta({ examples: ["chutes"] }),
    include_endpoints: z
      .boolean()
      .optional()
      .describe(
        "When true, embed each provider's endpoints instead of counts alone.",
      )
      .meta({ examples: [true] }),
  })
  .strict();
export type GetProviderDetailInput = z.infer<
  typeof GetProviderDetailInputSchema
>;

// Two shapes: the bare provider detail (default) or {provider, endpoints}
// when include_endpoints is set. Both are operator-controlled artifact
// payloads, so nothing is required in the hand-written original; the keys
// below describe each shape when present.
export const GetProviderDetailOutputSchema = ProviderArtifactSchema;
export type GetProviderDetailOutput = z.infer<
  typeof GetProviderDetailOutputSchema
>;
