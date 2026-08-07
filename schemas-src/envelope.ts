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

// Generic label -> non-negative count map (schemas/components/00-core.schema
// .json's CountMap) -- shared by many not-yet-converted components beyond
// this batch (curation_level_counts, by_confidence, tier_counts, etc.),
// hoisted here since it's a foundational leaf like the schemas above
// (types-epic B batch 8, #8062).
export const CountMapSchema = z.record(z.string(), z.int().min(0));
export type CountMap = z.infer<typeof CountMapSchema>;

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

// The bare artifact wrapper as its own published component (#9830) — what an
// artifact carries before any route-specific field is layered on. z.lazy()
// rather than a second reference to ArtifactBaseSchema: registering one Zod
// node under two ids would overwrite the first, and this emits exactly the
// `{"$ref": "#/components/schemas/ArtifactBase"}` alias the hand-written
// component published. No route may serve it — see SuccessEnvelopeSchema's
// note below for the gates that enforce that.
export const GenericArtifactSchema = z.lazy(() => ArtifactBaseSchema);

export const ResponseMetaSchema = z
  .object({
    artifact_path: z.string().optional(),
    cache: CacheProfileSchema.optional(),
    contract_version: z.string(),
    generated_at: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Deterministic build content marker (epoch by default); not a wall clock. Use published_at for human-facing freshness.",
      ),
    pagination: PaginationMetaSchema.optional(),
    // `.meta({format})` rather than z.iso.datetime() (#9830): the published
    // contract has always carried format:date-time here, and this keeps that
    // annotation without tightening what Zod ACCEPTS -- the schema is used to
    // validate real handler output in tests, and the producer is a KV pointer
    // this schema does not own.
    published_at: z
      .string()
      .meta({ format: "date-time" })
      .nullable()
      .optional()
      .describe(
        "Real publish time from the KV latest pointer, distinct from generated_at. Null before the first publish or when the control KV is unbound.",
      ),
    source: z.string().optional(),
    stale_contract: z
      .object({
        built_under: z
          .string()
          .describe("Contract version the served artifact was built under."),
        live: z
          .string()
          .describe("Current (live) contract version the Worker is running."),
      })
      .strict()
      .optional()
      .describe(
        "Present ONLY when the served artifact was built under an older contract than the live one (serve-time drift, #1001) — the body may predate a schema change. Mirrored on the x-metagraph-stale-contract response header for monitoring.",
      ),
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

// The shared SuccessEnvelope component (#9830) — the envelope shape with an
// unconstrained `data`, published so a consumer can describe "an envelope"
// without naming a route. Every real route publishes its OWN envelope with a
// typed `data`, built by the function above; this is the shape they all
// share, not a fallback any route is allowed to serve (validate-openapi.ts
// and validate-contract-drift.ts both reject a route whose data schema is a
// generic one).
export const SuccessEnvelopeSchema = successEnvelopeSchema(
  z.object({}).passthrough(),
);
export type SuccessEnvelope = z.infer<typeof SuccessEnvelopeSchema>;

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
