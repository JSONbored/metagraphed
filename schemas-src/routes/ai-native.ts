// The AI-native layer (ADR 0003) — POST /api/v1/ask, GET /api/v1/search/semantic,
// GET /api/v1/surfaces/{surface_id}/verify (#9092).
//
// All three shipped live and were never registered in src/contracts.ts, so
// they were absent from openapi.json, the generated types, and every typed
// client: the endpoints an agent would most want were the ones a machine
// reading our contract could not find.
//
// Modeled from the real production responses (captured 2026-08-02) and from
// the handlers in workers/api.ts, not from the prose — see the header comment
// on each schema for what the handler actually guarantees.
import { z } from "zod";
import { successEnvelopeSchema } from "../envelope.ts";

/**
 * One retrieved surface backing an answer.
 *
 * `ref` is the bracketed marker used inline in `answer` ("[1]"), so a client
 * can resolve a citation without re-running retrieval.
 */
export const AskCitationSchema = z
  .object({
    ref: z.int().min(1),
    score: z.number(),
    title: z.string(),
    netuid: z.int().min(0),
    slug: z.string(),
    url: z.string(),
  })
  .strict();

export const AskArtifactSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
    citations: z.array(AskCitationSchema),
    /** How many retrieved documents were in the model's context window. */
    context_count: z.int().min(0),
    /** The generation model, published so an answer stays attributable. */
    model: z.string(),
  })
  .passthrough();
export type AskArtifact = z.infer<typeof AskArtifactSchema>;
export const AskResponseSchema = successEnvelopeSchema(AskArtifactSchema);

/**
 * The request body. POST-only: the question is prose, and a URL is the wrong
 * place for it (length limits, logging, and cache keys all argue against it).
 */
export const AskRequestSchema = z
  .object({
    question: z.string().min(1),
  })
  .strict();
export type AskRequest = z.infer<typeof AskRequestSchema>;

/** `/ask` takes no query parameters — everything is in the body. */
export const AskQuerySchema = z.object({}).strict();
export type AskQuery = z.infer<typeof AskQuerySchema>;

export const SemanticSearchResultSchema = z
  .object({
    score: z.number(),
    /** What was matched — a subnet, or one of its surfaces. */
    type: z.string(),
    netuid: z.int().min(0),
    slug: z.string(),
    title: z.string(),
    subtitle: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    categories: z.array(z.string()),
    service_kinds: z.array(z.string()),
  })
  .passthrough();

export const SemanticSearchArtifactSchema = z
  .object({
    query: z.string(),
    count: z.int().min(0),
    results: z.array(SemanticSearchResultSchema),
    /** The embedding model, so a caller can tell two runs apart. */
    model: z.string(),
  })
  .passthrough();
export type SemanticSearchArtifact = z.infer<
  typeof SemanticSearchArtifactSchema
>;
export const SemanticSearchResponseSchema = successEnvelopeSchema(
  SemanticSearchArtifactSchema,
);

export const SemanticSearchQuerySchema = z
  .object({
    q: z.string().optional(),
    limit: z.string().optional(),
  })
  .strict();
export type SemanticSearchQuery = z.infer<typeof SemanticSearchQuerySchema>;

/**
 * A catalog-resolved probe of one registered surface.
 *
 * Deliberately NOT arbitrary URL fetching: the caller names a surface the
 * registry already knows, and the Worker probes the URL it has on file. That
 * is why the response echoes the resolved identity (`surface_key`, `netuid`,
 * `kind`, `url`, `provider`) alongside the probe outcome — a client can see
 * exactly what was called on its behalf.
 */
export const SurfaceVerifyArtifactSchema = z
  .object({
    schema_version: z.int(),
    surface_id: z.string(),
    surface_key: z.string(),
    netuid: z.int().min(0),
    kind: z.string(),
    url: z.string(),
    provider: z.string().nullable().optional(),
    auth_required: z.boolean(),
    status: z.string(),
    classification: z.string(),
    callable: z.boolean(),
    latency_ms: z.number().nullable().optional(),
    status_code: z.int().nullable().optional(),
    error: z.string().nullable().optional(),
    probed_at: z.string().nullable().optional(),
    /** True when the verdict came from the short-lived probe cache. */
    from_cache: z.boolean(),
  })
  .passthrough();
export type SurfaceVerifyArtifact = z.infer<typeof SurfaceVerifyArtifactSchema>;
export const SurfaceVerifyResponseSchema = successEnvelopeSchema(
  SurfaceVerifyArtifactSchema,
);

export const SurfaceVerifyQuerySchema = z.object({}).strict();
export type SurfaceVerifyQuery = z.infer<typeof SurfaceVerifyQuerySchema>;
