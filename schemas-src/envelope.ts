// Zod schemas for the shared REST response envelope (types-epic A, #7859) —
// the foundation the later types-epic sub-issues (#7860-#7864) generate from.
// This directory is deliberately NOT imported by any Worker entry yet; see
// each route file's own header for why.
//
// Shapes derived by reading, not memory, from:
//   - workers/responses.ts: dataResponse()/envelopeResponse() build the
//     success envelope `{ ok, schema_version, data, meta }` (contract_version
//     lives in meta, not top-level — envelopeResponse's `payload.meta`).
//   - workers/http.ts: errorResponse() builds the error envelope
//     `{ ok, schema_version, data: null, error: { code, message }, meta }`
//     and sets the x-metagraph-error-code header to the same `code`.
//   - public/metagraph/openapi.json's SuccessEnvelope/ErrorEnvelope/
//     ResponseMeta/PaginationMeta/CacheProfile/ArtifactBase components (built
//     from src/contracts.ts, the existing canonical JSON-Schema contract) —
//     cross-checked field-for-field against real handler output captured via
//     handleRequest()+createLocalArtifactEnv() for all 5 pilot routes (see
//     tests/zod-schemas.test.ts).
import { z } from "zod";

export const CacheProfileSchema = z.enum(["short", "standard", "static"]);
export type CacheProfile = z.infer<typeof CacheProfileSchema>;

export const PaginationMetaSchema = z
  .object({
    collection: z.string(),
    cursor: z.int().min(0),
    limit: z.int().min(0),
    next_cursor: z.int().min(0).nullable(),
    order: z.enum(["asc", "desc"]).optional(),
    returned: z.int().min(0),
    sort: z.string().nullable().optional(),
    total: z.int().min(0),
  })
  .strict();
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

// The static-artifact wrapper shape every /metagraph/*.json file carries
// (schema_version/generated_at + optional contract_version/notes), before a
// route's own fields are layered on via ArtifactBaseSchema.extend({...}) in
// each routes/*.ts file — mirrors the OpenAPI ArtifactBase component exactly.
export const ArtifactBaseSchema = z
  .object({
    contract_version: z.string().optional(),
    generated_at: z.string(),
    notes: z.union([z.string(), z.array(z.string())]).optional(),
    schema_version: z.literal(1),
  })
  .passthrough();
export type ArtifactBase = z.infer<typeof ArtifactBaseSchema>;

export const ResponseMetaSchema = z
  .object({
    artifact_path: z.string().optional(),
    cache: CacheProfileSchema.optional(),
    contract_version: z.string(),
    // Deterministic build content marker (epoch by default), not a wall
    // clock — see published_at for human-facing freshness (ResponseMeta's
    // own OpenAPI description).
    generated_at: z.string().nullable().optional(),
    pagination: PaginationMetaSchema.optional(),
    published_at: z.string().nullable().optional(),
    source: z.string().optional(),
    // Present ONLY on serve-time drift (#1001): the served artifact was
    // built under an older contract than the live one.
    stale_contract: z
      .object({
        built_under: z.string(),
        live: z.string(),
      })
      .strict()
      .optional(),
  })
  // meta carries route-specific extra fields beyond this shared shape
  // (workers/responses.ts's `extraMeta`/`payload.meta` are open records) —
  // real openness in the contract, not a placeholder.
  .passthrough();
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

// Generic success-envelope builder — one schema per route via
// successEnvelopeSchema(RouteDataSchema), matching envelopeResponse()'s
// `{ ok: true, schema_version: 1, data, meta }` exactly.
export function successEnvelopeSchema<DataSchema extends z.ZodType>(
  dataSchema: DataSchema,
) {
  return z
    .object({
      ok: z.literal(true),
      schema_version: z.literal(1),
      data: dataSchema,
      meta: ResponseMetaSchema,
    })
    .strict();
}

// Matches errorResponse()'s `{ ok: false, schema_version: 1, data: null,
// error: { code, message }, meta }` — one shape for every error response,
// no per-route variation.
export const ErrorEnvelopeSchema = z
  .object({
    ok: z.literal(false),
    schema_version: z.literal(1),
    data: z.null(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict(),
    meta: ResponseMetaSchema,
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
