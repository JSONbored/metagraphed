// MCP tools `list_subnet_apis`, `get_api_schema`, `get_fixture`,
// `get_provider_detail` (types-epic E batch 9, #8073). Each is defined
// inline in src/mcp-server.ts's MCP_TOOLS array (unlike this batch's other
// 13 tools, which live in separate src/*-mcp.ts files). None mirror an
// existing schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
import { z } from "zod";
import {
  OpenArraySchema,
  OpenObjectSchema,
  netuidSchema,
  surfaceIdSchema,
} from "./shared.ts";

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
    services: z.array(OpenObjectSchema),
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
export const GetProviderDetailOutputSchema = z
  .object({
    id: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    authority: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    provider: OpenObjectSchema.nullable().optional(),
    endpoints: z
      .union([OpenObjectSchema, OpenArraySchema])
      .nullable()
      .optional(),
  })
  .passthrough();
export type GetProviderDetailOutput = z.infer<
  typeof GetProviderDetailOutputSchema
>;
