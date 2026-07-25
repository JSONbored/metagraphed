// GET /api/v1/fixtures, GET /api/v1/fixtures/{surface_id} (types-epic B
// batch 8, #8062). list_fixtures (types-epic E batch 11, #8074's
// catalog-indexes.ts) mirrors GET /api/v1/fixtures and confirms it's a
// no-input, baked-artifact passthrough route; GET /api/v1/fixtures/
// {surface_id} takes its surface_id as a path param, not a query param, so
// neither route needs a Query schema. Modeled from the hand-edited
// FixturesIndexArtifact/FixtureArtifact components they replace.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";
import { SurfaceKindSchema } from "./subnet-detail.ts";

// Bare `{type:"object", additionalProperties:true}` (hand-written
// JsonObject component) -- registered under its existing name since it's a
// standalone public component (see shared.ts's OpenObjectSchema for the
// epic's established equivalent for this exact shape, kept separate here
// so JsonObject's own name survives).
export const JsonObjectSchema = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const FixturesIndexArtifactSchema = ArtifactBaseSchema.extend({
  published_at: z.string().nullable().optional(),
  candidate_count: z.int().min(0).optional(),
  fixture_count: z.int().min(0),
  missing_count: z.int().min(0).optional(),
  status_counts: z.record(z.string(), z.int().min(0)).optional(),
  coverage: z
    .array(
      z
        .object({
          surface_id: z.string(),
          netuid: z.int().min(0),
          subnet_slug: z.string().nullable().optional(),
          kind: z.string().optional(),
          status: z.enum(["available", "missing", "capture-failed"]),
          reason: z.string().nullable().optional(),
          captured_at: z.string().nullable().optional(),
          response_status: z.int().nullable().optional(),
          artifact_path: z.string().nullable().optional(),
        })
        .passthrough(),
    )
    .optional(),
  fixtures: z.array(
    z
      .object({
        surface_id: z.string(),
        netuid: z.int().min(0),
        subnet_slug: z.string().nullable().optional(),
        kind: z.string().optional(),
        captured_at: z.string().nullable().optional(),
        response_status: z.int().nullable().optional(),
      })
      .passthrough(),
  ),
}).passthrough();
export type FixturesIndexArtifact = z.infer<typeof FixturesIndexArtifactSchema>;
export const FixturesIndexResponseSchema = successEnvelopeSchema(
  FixturesIndexArtifactSchema,
);

export const FixtureArtifactSchema = ArtifactBaseSchema.extend({
  surface_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
  netuid: z.int().min(0),
  subnet_slug: z.string().nullable().optional(),
  subnet_name: z.string().nullable().optional(),
  kind: SurfaceKindSchema,
  captured_at: z.iso.datetime().nullable().optional(),
  request: z
    .object({
      method: z.literal("GET"),
      url: z.url(),
    })
    .passthrough(),
  response: z
    .object({
      status: z.int(),
      content_type: z.string().nullable().optional(),
      body: z.union([
        JsonObjectSchema,
        z.array(z.unknown()),
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
      ]),
    })
    .passthrough(),
}).passthrough();
export type FixtureArtifact = z.infer<typeof FixtureArtifactSchema>;
export const FixtureResponseSchema = successEnvelopeSchema(
  FixtureArtifactSchema,
);
