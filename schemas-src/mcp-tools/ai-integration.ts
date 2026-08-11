// MCP tools `how_do_i_call`, `verify_integration`, `call_subnet_surface`
// (types-epic E batch 12, #8076). All three are defined inline in
// src/mcp-server.ts's MCP_TOOLS array. None mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field.
import { z } from "zod";
import {
  OpenArraySchema,
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
/**
 * One callable service, as the integration guide RESHAPES it (#9797).
 *
 * Modeled, not derived. This is not a subset of the catalog service record:
 * `auth` collapses the catalog's auth_required/auth_schemes pair into
 * `{required, schemes}`, `health` keeps three of its seven fields, and
 * `schema`/`fixture` are rewritten into "can I use this, and how" answers.
 * Deriving from AgentCatalogServiceSchema fails against production on
 * `auth.scheme` alone.
 *
 * Censused across 41 rows from three subnets on 2026-08-07: all ten keys
 * present on every row. The nested blocks stay passthrough with only their
 * always-present keys declared -- `fetch_with` appears once a schema or
 * fixture is actually available, which is measured rather than assumed.
 */
const HowDoICallServiceSchema = z
  .object({
    surface_id: z.string(),
    kind: z.string(),
    capability: z.string(),
    base_url: z.string(),
    callable: z.boolean(),
    auth: z
      .object({ required: z.boolean(), schemes: z.array(z.string()) })
      .strict(),
    snippets: z
      .object({ curl: z.string(), python: z.string(), typescript: z.string() })
      .strict(),
    // TWO BRANCHES, and only the unavailable one was declared (#10790). When a
    // schema or fixture EXISTS the producer adds the tool call that fetches it
    // -- which is the entire point of `how_do_i_call` -- and when it does not,
    // it says which check failed. Both were served undeclared.
    schema: z
      .object({
        available: z.boolean(),
        schema_url: z.string().nullable(),
        fetch_with: z
          .string()
          .optional()
          .describe(
            "The exact tool call that returns this schema. Present only when one exists.",
          ),
      })
      .strict(),
    fixture: z
      .object({
        available: z.boolean(),
        fetch_with: z.string().optional(),
        artifact_path: z.string().nullable().optional(),
        captured_at: z.string().nullable().optional(),
        response_status: z.int().nullable().optional(),
        content_type: z.string().nullable().optional(),
        status: z
          .string()
          .optional()
          .describe(
            "Why there is no fixture, as a code. Absent when there is one.",
          ),
        reason: z.string().optional().describe("The same, in words."),
      })
      .strict(),
    health: z
      .object({
        status: z.string(),
        stale: z.boolean(),
        // NULLABLE, and the emitter is the authority here rather than the
        // capture: src/mcp-server.ts writes `s.health?.observed_by ?? null`.
        // Production always had an observer so 41/41 censused rows carried a
        // string, and modelling from the capture alone published a contract
        // the cold path breaks -- caught by validate:mcp's hermetic harness,
        // which is the only place that path runs. Same lesson as #9941.
        observed_by: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const HowDoICallOutputSchema = z
  .object({
    netuid: netuidSchema(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    integration_readiness: z.unknown().optional(),
    callable: z.boolean(),
    callable_count: z.int().optional(),
    guidance: z.unknown().optional(),
    services: z.array(HowDoICallServiceSchema),
    next_steps: OpenArraySchema.optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .strict();
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
  .strict();
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
  .strict();
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
  .strict();
export type StoreSurfaceCredentialOutput = z.infer<
  typeof StoreSurfaceCredentialOutputSchema
>;

export const ListSurfaceCredentialsInputSchema = z.object({}).strict();
export type ListSurfaceCredentialsInput = z.infer<
  typeof ListSurfaceCredentialsInputSchema
>;

export const ListSurfaceCredentialsOutputSchema = z
  .object({
    // Modeled from the producer, not from a capture (#9797): the store is
    // authenticated, so production cannot be sampled without a credential.
    // src/mcp-surface-credentials.ts builds exactly this object and coalesces
    // every field, so none can be absent -- `expires_at`/`created_at` fall back
    // to "" rather than undefined, which is why they are required strings
    // rather than optional. `shape` is the two-value literal that file
    // narrows to. NO credential VALUE appears here, and none ever should:
    // this tool reads non-secret metadata and decrypts nothing.
    credentials: z.array(
      z
        .object({
          surface_id: z.string(),
          shape: z.enum(["string", "object"]),
          created_at: z.string(),
          expires_at: z.string(),
        })
        .strict(),
    ),
    count: z.int(),
  })
  .strict();
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
  .strict();
export type DeleteSurfaceCredentialOutput = z.infer<
  typeof DeleteSurfaceCredentialOutputSchema
>;
