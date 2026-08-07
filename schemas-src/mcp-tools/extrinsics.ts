// MCP tool `list_extrinsics`.
// Mirrors GET /api/v1/extrinsics.
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

/**
 * Page-size ceiling for the extrinsics feeds and the two fixed-call_module feeds
 * modelled on them (get_sudo, get_governance_config_changes). Exported so those two
 * read it rather than restating it — they previously declared no maximum at all.
 */
export const EXTRINSICS_LIMIT_MAX = 100;
import { AccountEventItemSchema, OpenObjectSchema } from "./shared.ts";
import { ExtrinsicsFeedArtifactSchema } from "../routes/extrinsics.ts";

const Ss58Schema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{47,48}$/);

export const ListExtrinsicsInputSchema = z
  .object({
    block: z
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this exact block height.")
      .meta({ examples: [8783000] }),
    signer: Ss58Schema.optional()
      .describe(
        "Restrict to extrinsics signed by this SS58 account. Unsigned (inherent) extrinsics never match.",
      )
      .meta({ examples: ["5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"] }),
    call_module: z
      .string()
      .optional()
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
    call_function: z
      .string()
      .optional()
      .describe(
        "Restrict to one call within the pallet (`add_stake`). Case-sensitive; pair with `call_module` to disambiguate.",
      )
      .meta({ examples: ["add_stake"] }),
    call_hash: z
      .string()
      .optional()
      .describe("Restrict to the extrinsic with this 0x-prefixed hash.")
      .meta({
        examples: [
          "0x9f1e2d3c4b5a69788796a5b4c3d2e1f009182736455463728190abcdef012345",
        ],
      }),
    success: z
      .boolean()
      .optional()
      .describe(
        "Restrict to successful (`true`) or failed (`false`) extrinsics. Omit for both.",
      )
      .meta({ examples: [true] }),
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
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type ListExtrinsicsInput = z.infer<typeof ListExtrinsicsInputSchema>;

export const ListExtrinsicsOutputSchema = ExtrinsicsFeedArtifactSchema;
export type ListExtrinsicsOutput = z.infer<typeof ListExtrinsicsOutputSchema>;

export const GetExtrinsicInputSchema = z
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
export type GetExtrinsicInput = z.infer<typeof GetExtrinsicInputSchema>;

export const GetExtrinsicOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    ref: z.unknown(),
    extrinsic: OpenObjectSchema.nullable().optional(),
    events: z.array(AccountEventItemSchema).optional(),
  })
  .passthrough();
export type GetExtrinsicOutput = z.infer<typeof GetExtrinsicOutputSchema>;
