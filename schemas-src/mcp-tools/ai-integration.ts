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
} from "./shared.ts";

export const HowDoICallInputSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    subnet: z.string().optional(),
  })
  .strict();
export type HowDoICallInput = z.infer<typeof HowDoICallInputSchema>;

// `callable_count`/`next_steps` are always set by the handler but, like
// several sibling AI tools' loosely-required fields in this batch, were
// never added to the hand-written original's `required` array -- preserved
// as-is.
export const HowDoICallOutputSchema = z
  .object({
    netuid: z.int(),
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
    surface_id: z.string().optional(),
    netuid: z.int().min(0).optional(),
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
    netuid: z.int().nullable().optional(),
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
    surface_id: z.string(),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    path: z.string().optional(),
    method: z.enum(["GET", "HEAD", "POST", "PUT"]).optional(),
    // Branch order (object, then string) mirrors the hand-written original's
    // `type: ["object", "string"]`.
    body: z.union([OpenObjectSchema, z.string()]).optional(),
    content_type: z.string().optional(),
    // Branch order (string, then object) mirrors the hand-written original's
    // `type: ["string", "object"]` -- the reverse of `body` above.
    credential: z.union([z.string(), OpenObjectSchema]).optional(),
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
    surface_id: z.string(),
    // Same two shapes call_subnet_surface accepts in-band: a single opaque
    // string for bearer/api-key/basic schemes, or a {name: value} bundle
    // for scheme:signature. Branch order (string, then object) mirrors
    // CallSubnetSurfaceInputSchema's `credential`.
    credential: z.union([z.string(), OpenObjectSchema]),
    ttl_seconds: z.int().min(60).max(7_776_000).optional(),
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
    surface_id: z.string(),
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
