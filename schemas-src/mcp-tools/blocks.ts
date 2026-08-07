// MCP tools `list_block_extrinsics`, `list_blocks`, `get_block_events`.
// Mirror GET /api/v1/blocks/{ref}/extrinsics, GET /api/v1/blocks, GET
// /api/v1/blocks/{ref}/events.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
} from "./shared.ts";
import { BlockEventsArtifactSchema } from "../routes/block-events.ts";
import { BlockExtrinsicsArtifactSchema } from "../routes/block-extrinsics.ts";
import { BlockSchema, BlocksFeedArtifactSchema } from "../routes/blocks.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListBlocksInputSchema = z
  .object({
    author: Ss58Schema.optional()
      .describe(
        "Restrict to blocks authored by this SS58 validator hotkey. Only populated below the decode watermark; recent head blocks may not carry an author yet.",
      )
      .meta({ examples: ["5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV"] }),
    spec_version: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Restrict to blocks running this runtime spec version — the number that changes at a runtime upgrade.",
      )
      .meta({ examples: [441] }),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    from: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive start of the range. A block height on chain tools, an ISO-8601 date on time-series ones.",
      )
      .meta({ examples: [8700000] }),
    to: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive end of the range. A block height on chain tools, an ISO-8601 date on time-series ones; an EVM address on decode_evm_call.",
      )
      .meta({ examples: [8783000] }),
    min_extrinsics: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on a block's extrinsic count; quieter blocks are excluded.",
      )
      .meta({ examples: [5] }),
    min_events: z
      .int()
      .min(0)
      .optional()
      .describe(
        "Inclusive lower bound on a block's event count; quieter blocks are excluded.",
      )
      .meta({ examples: [20] }),
    limit: limitSchema(100).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type ListBlocksInput = z.infer<typeof ListBlocksInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const ListBlocksOutputSchema = BlocksFeedArtifactSchema;
export type ListBlocksOutput = z.infer<typeof ListBlocksOutputSchema>;

export const GetBlockInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({
        examples: [
          "8783000",
          "0x9f1e2d3c4b5a69788796a5b4c3d2e1f009182736455463728190abcdef012345",
        ],
      }),
  })
  .strict();
export type GetBlockInput = z.infer<typeof GetBlockInputSchema>;

export const GetBlockOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    // Typed from the route's own BlockSchema (#9797). Not partial, unlike the
    // neuron rows: get_block advertises no `fields` parameter, so no caller can
    // project a field away. Verified against production 2026-08-07.
    block: BlockSchema.nullable().optional(),
    prev_block_number: z.int().nullable().optional(),
    next_block_number: z.int().nullable().optional(),
  })
  .passthrough();
export type GetBlockOutput = z.infer<typeof GetBlockOutputSchema>;

export const ListBlockExtrinsicsInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({
        examples: [
          "8783000",
          "0x9f1e2d3c4b5a69788796a5b4c3d2e1f009182736455463728190abcdef012345",
        ],
      }),
    limit: limitSchema(100).optional(),
    offset: offsetSchema().optional(),
  })
  .strict();
export type ListBlockExtrinsicsInput = z.infer<
  typeof ListBlockExtrinsicsInputSchema
>;

export const ListBlockExtrinsicsOutputSchema = BlockExtrinsicsArtifactSchema;
export type ListBlockExtrinsicsOutput = z.infer<
  typeof ListBlockExtrinsicsOutputSchema
>;

export const GetBlockEventsInputSchema = z
  .object({
    ref: z
      .string()
      .describe(
        "Block reference: either a block NUMBER or a 0x-prefixed block HASH. Both forms are accepted and resolve to the same block.",
      )
      .meta({
        examples: [
          "8783000",
          "0x9f1e2d3c4b5a69788796a5b4c3d2e1f009182736455463728190abcdef012345",
        ],
      }),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
  })
  .strict();
export type GetBlockEventsInput = z.infer<typeof GetBlockEventsInputSchema>;

export const GetBlockEventsOutputSchema = BlockEventsArtifactSchema;
export type GetBlockEventsOutput = z.infer<typeof GetBlockEventsOutputSchema>;
