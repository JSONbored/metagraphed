// GET /api/v1/sudo (types-epic B batch 7, #8061). Live extrinsics D1-tier
// data -- no static file. handleSudo (workers/request-handlers/entities.ts)
// calls buildExtrinsicFeed() directly (the extrinsics feed hardcoded to
// call_module='Sudo'), so this route reuses extrinsics.ts's
// ExtrinsicsFeedResponseSchema unchanged -- the hand-edited OpenAPI document
// itself $refs the same ExtrinsicsFeedArtifact component here (verified via
// repo-wide $ref grep).
import { z } from "zod";
import { ExtrinsicsFeedResponseSchema } from "./extrinsics.ts";

export const SudoResponseSchema = ExtrinsicsFeedResponseSchema;
export const SudoQuerySchema = z
  .object({
    limit: z.int().min(1).optional(),
    offset: z.int().min(0).optional(),
    cursor: z.string().optional(),
    block: z.int().min(0).optional(),
    call_function: z.string().optional(),
    success: z.enum(["true", "false"]).optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();
export type SudoQuery = z.infer<typeof SudoQuerySchema>;
