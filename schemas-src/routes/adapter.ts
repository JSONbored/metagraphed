// GET /api/v1/adapters/{slug} (types-epic B batch 8, #8062). slug is a path
// param, not a query param -- no Query schema needed (mirrors the
// get_adapter MCP tool, types-epic E batch 11, #8074's get-adapter.ts).
// Modeled from the hand-edited AdapterArtifact component it replaces.
import { z } from "zod";
import { ArtifactBaseSchema, successEnvelopeSchema } from "../envelope.ts";

/** What the adapter last captured. Was a bare open object (#9800), so the
 * field the whole artifact exists to carry declared nothing -- not even its
 * own capture stamp.
 *
 * `dimensions` is keyed by whatever the adapter tracks (gittensor:
 * bounties/contributions/…; the generic OpenAPI adapter: openapi_schemas),
 * so it stays a record. Its VALUE carries a small common core -- every entry
 * observed reports a `status`, and the documentation-only ones carry the
 * `notes`/`source_url` explaining why -- and `.passthrough()` keeps the
 * adapter-specific rest. */
const AdapterSnapshotSchema = z
  .object({
    schema_version: z.int().optional(),
    contract_version: z.string().optional(),
    generated_at: z.string().nullable().optional(),
    slug: z.string().optional(),
    netuid: z.int().min(0).optional(),
    source: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    notes: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    adapter_kind: z.string().nullable().optional(),
    excluded_dimensions: z.array(z.string()).optional(),
    dimensions: z
      .record(
        z.string(),
        z
          .object({
            status: z
              .string()
              .optional()
              .describe(
                "`docs-only` means the dimension is documented but has no verified unauthenticated API surface -- a gap, not a capture failure.",
              ),
            notes: z.string().nullable().optional(),
            source_url: z.string().nullable().optional(),
            captured_at: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const AdapterArtifactSchema = ArtifactBaseSchema.extend({
  netuid: z.int().min(0),
  subnet: z.string(),
  slug: z.string(),
  // GENUINELY OPEN, and the only site in this file that stays that way
  // (#9800). Keyed by adapter slug, and the value is whatever that adapter
  // chose to publish about itself -- gittensor ships tracked/excluded
  // dimension lists, the generic OpenAPI adapter ships something else
  // entirely. There is no shape to declare, so the contract says so instead
  // of pretending. Listed in scripts/validate-schema-opacity.ts.
  extensions: z.record(z.string(), z.object({}).passthrough()),
  snapshot: AdapterSnapshotSchema.nullable().optional(),
}).passthrough();
export type AdapterArtifact = z.infer<typeof AdapterArtifactSchema>;
export const AdapterResponseSchema = successEnvelopeSchema(
  AdapterArtifactSchema,
);
