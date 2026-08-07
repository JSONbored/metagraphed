// MCP tool `get_account_extrinsics`.
// Mirrors GET /api/v1/accounts/{ss58}/extrinsics.
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
  ss58Schema,
} from "./shared.ts";
import { AccountExtrinsicsArtifactSchema } from "../routes/account-extrinsics.ts";

export const GetAccountExtrinsicsInputSchema = z
  .object({
    ss58: ss58Schema(),
    block_start: blockBoundSchema("first").optional(),
    block_end: blockBoundSchema("last").optional(),
    limit: limitSchema(1000).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetAccountExtrinsicsInput = z.infer<
  typeof GetAccountExtrinsicsInputSchema
>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetAccountExtrinsicsOutputSchema = AccountExtrinsicsArtifactSchema;
export type GetAccountExtrinsicsOutput = z.infer<
  typeof GetAccountExtrinsicsOutputSchema
>;
