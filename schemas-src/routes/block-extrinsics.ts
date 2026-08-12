// GET /api/v1/blocks/{ref}/extrinsics (types-epic B batch 7, #8061). Live
// extrinsics store-tier data -- no static file. Modeled from src/extrinsics.ts's
// buildBlockExtrinsics(), cross-checked against the hand-edited
// BlockExtrinsicsArtifact component it replaces. Reuses ExtrinsicSchema from
// extrinsics.ts (the same batch's own conversion of that route).
import { z } from "zod";
import { ExtrinsicSchema } from "./extrinsics.ts";

export const BlockExtrinsicsArtifactSchema = z
  .object({
    schema_version: z.int(),
    ref: z.string().nullable(),
    block_number: z.int().min(0).nullable(),
    extrinsic_count: z.int().min(0),
    // NULLABLE, and this is not defensive (#9796). The REST layer defaults
    // `limit`/`offset` before the loader runs, so a live route response always
    // carries integers -- which is why validate:api never saw this. The same
    // loader also serves the MCP tool, which passes the caller's arguments
    // straight through, and an omitted limit reaches it as undefined:
    // `limit: limit ?? null` then emits null. The contract said that was
    // impossible.
    limit: z.int().nullable(),
    offset: z.int().nullable(),
    extrinsics: z.array(ExtrinsicSchema),
  })
  .strict()
  .describe(
    "One block's extrinsics list (#6977). Rows are the opaque JSON extrinsic shape the extrinsics feed uses; block_number is null for an unknown ref.",
  );
export type BlockExtrinsicsArtifact = z.infer<
  typeof BlockExtrinsicsArtifactSchema
>;
