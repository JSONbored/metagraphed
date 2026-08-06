// MCP tools `how_do_i_call`, `verify_integration`, `call_subnet_surface`
// (types-epic E batch 12, #8076). All three are defined inline in
// src/mcp-server.ts's MCP_TOOLS array. None mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
import { z } from "zod";
import {
  OpenArraySchema,
  OpenObjectArraySchema,
  OpenObjectSchema,
  netuidSchema,
  surfaceIdSchema,
} from "./shared.ts";

export const HowDoICallInputSchema = z
  .object({
    netuid: netuidSchema().optional(),
    subnet: z
      .string()
      .optional()
      .describe(
        "A subnet by slug (`chutes`) or chain name. Use `netuid` instead when you have the numeric id.",
      )
      .meta({ examples: ["chutes"] }),
  })
  .strict();
export type HowDoICallInput = z.infer<typeof HowDoICallInputSchema>;

// `callable_count`/`next_steps` are always set by the handler but, like
// several sibling AI tools' loosely-required fields in this batch, were
// never added to the hand-written original's `required` array -- preserved
// as-is.
export const HowDoICallOutputSchema = z
  .object({
    netuid: netuidSchema(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    integration_readiness: z.unknown().optional(),
    callable: z.boolean(),
    callable_count: z.int().optional(),
    guidance: z.unknown().optional(),
    services: OpenObjectArraySchema,
    next_steps: OpenArraySchema.optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type HowDoICallOutput = z.infer<typeof HowDoICallOutputSchema>;

export const VerifyIntegrationInputSchema = z
  .object({
    surface_id: surfaceIdSchema().optional(),
    netuid: netuidSchema().optional(),
  })
  .strict();
export type VerifyIntegrationInput = z.infer<
  typeof VerifyIntegrationInputSchema
>;

// `kind`/`url`/`from_cache` are declared as plain (non-nullable) optional
// fields in the hand-written original -- present in `properties` but absent
// from `required`, unlike every NULLABLE_* field here which is both
// optional AND nullable. Preserved as-is.
export const VerifyIntegrationOutputSchema = z
  .object({
    surface_id: z.string(),
    surface_key: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    kind: z.string().optional(),
    url: z.string().optional(),
    provider: z.string().nullable().optional(),
    status: z.string(),
    classification: z.string().nullable().optional(),
    callable: z.boolean(),
    latency_ms: z.int().nullable().optional(),
    status_code: z.int().nullable().optional(),
    error: z.string().nullable().optional(),
    probed_at: z.string().nullable().optional(),
    from_cache: z.boolean().optional(),
  })
  .passthrough();
export type VerifyIntegrationOutput = z.infer<
  typeof VerifyIntegrationOutputSchema
>;

export const CallSubnetSurfaceInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        "Query-string parameters to append, as a flat object of " +
          "string/number/boolean values. Nested objects and arrays are not " +
          "supported — encode them into `path` or `body` instead.",
      )
      .meta({ examples: ["inference"] }),
    path: z
      .string()
      .optional()
      .describe(
        "Path appended to the surface's base URL, e.g. `/v1/status`. Leading slash optional.",
      )
      // uri-reference, not uri: this is a RELATIVE path resolved against the
      // surface's own base URL, so `uri` (which wants a scheme) would be the
      // wrong assertion (#9659).
      .meta({ format: "uri-reference", examples: ["/v1/status"] }),
    method: z
      .enum(["GET", "HEAD", "POST", "PUT"])
      .optional()
      .describe("HTTP method to use for the call.")
      .meta({ examples: ["GET"] }),
    // Branch order (object, then string) mirrors the hand-written original's
    // `type: ["object", "string"]`.
    body: z
      .union([OpenObjectSchema, z.string()])
      .optional()
      .describe(
        "Request body: an object (sent as JSON) or a pre-serialized string.",
      )
      .meta({ examples: [{ prompt: "hello" }] }),
    content_type: z
      .string()
      .optional()
      .describe(
        "Overrides the Content-Type header. Defaults to `application/json` when the body is an object.",
      )
      .meta({ examples: ["application/json"] }),
    // Branch order (string, then object) mirrors the hand-written original's
    // `type: ["string", "object"]` -- the reverse of `body` above.
    credential: z
      .union([z.string(), OpenObjectSchema])
      .optional()
      .describe(
        "Secret for an authenticated surface: a bearer token string, or an object of header/query values. Sent to the surface and never stored unless you use store_surface_credential.",
      )
      .meta({ examples: ["Bearer <token>"] }),
  })
  .strict();
export type CallSubnetSurfaceInput = z.infer<
  typeof CallSubnetSurfaceInputSchema
>;

export const CallSubnetSurfaceOutputSchema = z
  .object({
    surface_id: z.string(),
    url: z.string(),
    status_code: z.int(),
    content_type: z.string().nullable().optional(),
    latency_ms: z.int().nullable().optional(),
    body: z.unknown().optional(),
    truncated: z.boolean(),
    parse_error: z.string().nullable().optional(),
    // #9009: set only when an AUTHENTICATED caller passed `credential`
    // in-band -- the deprecation window's per-call notice.
    credential_deprecation: z.string().optional(),
    // #9009: "argument" (in-band) or "stored" (resolved from the caller's
    // registered credential). Absent for surfaces that need no credential.
    credential_source: z.enum(["argument", "stored"]).optional(),
  })
  .passthrough();
export type CallSubnetSurfaceOutput = z.infer<
  typeof CallSubnetSurfaceOutputSchema
>;

// MCP tools `store_surface_credential` / `list_surface_credentials` /
// `delete_surface_credential` (#9009): the session-bound credential store
// that moves auth_required surface secrets out of call_subnet_surface's
// tool arguments for authenticated callers. Defined inline in
// src/mcp-server.ts's MCP_TOOLS array, backed by
// src/mcp-surface-credentials.ts.

export const StoreSurfaceCredentialInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
    // Same two shapes call_subnet_surface accepts in-band: a single opaque
    // string for bearer/api-key/basic schemes, or a {name: value} bundle
    // for scheme:signature. Branch order (string, then object) mirrors
    // CallSubnetSurfaceInputSchema's `credential`.
    credential: z
      .union([z.string(), OpenObjectSchema])
      .describe(
        "Secret for an authenticated surface: a bearer token string, or an object of header/query values. Sent to the surface and never stored unless you use store_surface_credential.",
      )
      .meta({ examples: ["Bearer <token>"] }),
    ttl_seconds: z
      .int()
      .min(60)
      .max(7_776_000)
      .optional()
      .describe("How long the stored credential remains valid, in seconds.")
      .meta({ examples: [3600] }),
  })
  .strict();
export type StoreSurfaceCredentialInput = z.infer<
  typeof StoreSurfaceCredentialInputSchema
>;

export const StoreSurfaceCredentialOutputSchema = z
  .object({
    surface_id: z.string(),
    stored: z.boolean(),
    expires_at: z.string(),
    replaced: z.boolean(),
  })
  .passthrough();
export type StoreSurfaceCredentialOutput = z.infer<
  typeof StoreSurfaceCredentialOutputSchema
>;

export const ListSurfaceCredentialsInputSchema = z.object({}).strict();
export type ListSurfaceCredentialsInput = z.infer<
  typeof ListSurfaceCredentialsInputSchema
>;

export const ListSurfaceCredentialsOutputSchema = z
  .object({
    credentials: OpenObjectArraySchema,
    count: z.int(),
  })
  .passthrough();
export type ListSurfaceCredentialsOutput = z.infer<
  typeof ListSurfaceCredentialsOutputSchema
>;

export const DeleteSurfaceCredentialInputSchema = z
  .object({
    surface_id: surfaceIdSchema(),
  })
  .strict();
export type DeleteSurfaceCredentialInput = z.infer<
  typeof DeleteSurfaceCredentialInputSchema
>;

export const DeleteSurfaceCredentialOutputSchema = z
  .object({
    surface_id: z.string(),
    deleted: z.boolean(),
  })
  .passthrough();
export type DeleteSurfaceCredentialOutput = z.infer<
  typeof DeleteSurfaceCredentialOutputSchema
>;
