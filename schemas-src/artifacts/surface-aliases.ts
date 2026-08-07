// /metagraph/surface-aliases.json -> SurfaceAliasesArtifact (#9830).
//
// A published artifact with no REST route of its own, which is why it lives
// under artifacts/ rather than routes/: nothing in API_ROUTES serves it, but
// contracts.json publishes its path and schema_ref, so the component is part
// of the public contract exactly like a route artifact is.
//
// Modeled from src/surface-aliases.ts's buildSurfaceAliasArtifact() and
// aliasEntry(), which are the only producers. Every field below is set
// unconditionally by one of those two functions -- the three nullable ones
// are `?? nullableX(previous?.…)`, which returns null rather than omitting
// the key.
import { z } from "zod";
import { ArtifactBaseSchema } from "../envelope.ts";

const SurfaceAliasEntrySchema = z
  .object({
    deprecated_id: z
      .string()
      .describe(
        "The surface id that used to be served and no longer is. This is the lookup key: resolveSurfaceAlias() matches an incoming surface id against it.",
      ),
    surface_key: z
      .string()
      .describe(
        "The stable identity (`srf-<hash of netuid|kind|url>`) both ids share -- what makes this a rename rather than two unrelated surfaces (#1005).",
      ),
    current_id: z
      .string()
      .describe("The surface id that replaced `deprecated_id`."),
    netuid: z.int().min(0).nullable(),
    kind: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

const SurfaceAliasesSummarySchema = z
  .object({
    alias_count: z.int().min(0),
    carried_alias_count: z
      .int()
      .min(0)
      .describe(
        "Aliases inherited from the previous artifact -- a rename recorded by an earlier build whose surface still exists.",
      ),
    new_alias_count: z
      .int()
      .min(0)
      .describe("Aliases this build discovered for the first time."),
    previous_surface_count: z.int().min(0),
    current_surface_count: z.int().min(0),
  })
  .strict();

export const SurfaceAliasesArtifactSchema = ArtifactBaseSchema.extend({
  source: z.literal("generated-surface-rename-aliases"),
  summary: SurfaceAliasesSummarySchema,
  aliases: z.array(SurfaceAliasEntrySchema),
});
export type SurfaceAliasesArtifact = z.infer<
  typeof SurfaceAliasesArtifactSchema
>;
