// MCP tools `get_chain_calls`, `get_chain_signers`, `get_chain_fees`.
// Mirror GET /api/v1/chain/calls, GET /api/v1/chain/signers, GET
// /api/v1/chain/fees.
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
import { ROUTE_QUERY_SCHEMAS } from "../route-queries.ts";

import {
  ChainCallsArtifactSchema,
  ChainFeesArtifactSchema,
  ChainSignersArtifactSchema,
} from "../routes/chain-analytics.ts";

const RouteQuery_chain_calls = ROUTE_QUERY_SCHEMAS["/api/v1/chain/calls"];

const RouteQuery_chain_signers = ROUTE_QUERY_SCHEMAS["/api/v1/chain/signers"];

const RouteQuery_chain_fees = ROUTE_QUERY_SCHEMAS["/api/v1/chain/fees"];

export const GetChainCallsInputSchema = z
  .object({
    window: RouteQuery_chain_calls.shape.window,
    group_by: RouteQuery_chain_calls.shape.group_by
      .describe(
        "How to bucket the counts: by pallet, or by pallet and call together.",
      )
      .meta({ examples: ["module"] }),
    limit: RouteQuery_chain_calls.shape.limit.meta({ default: 50 }),
    call_module: RouteQuery_chain_calls.shape.call_module
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainCallsInput = z.infer<typeof GetChainCallsInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch).
export const GetChainCallsOutputSchema = ChainCallsArtifactSchema;
export type GetChainCallsOutput = z.infer<typeof GetChainCallsOutputSchema>;

export const GetChainSignersInputSchema = z
  .object({
    window: RouteQuery_chain_signers.shape.window,
    sort: RouteQuery_chain_signers.shape.sort,
    limit: RouteQuery_chain_signers.shape.limit.meta({ default: 50 }),
    call_module: RouteQuery_chain_signers.shape.call_module
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainSignersInput = z.infer<typeof GetChainSignersInputSchema>;

// objectItems(...) properties, none required at the item level.
export const GetChainSignersOutputSchema = ChainSignersArtifactSchema;
export type GetChainSignersOutput = z.infer<typeof GetChainSignersOutputSchema>;

export const GetChainFeesInputSchema = z
  .object({
    window: RouteQuery_chain_fees.shape.window,
    limit: RouteQuery_chain_fees.shape.limit.meta({ default: 25 }),
    call_module: RouteQuery_chain_fees.shape.call_module
      .describe(
        "Restrict to one pallet, by its runtime name (`SubtensorModule`). Case-sensitive.",
      )
      .meta({ examples: ["SubtensorModule"] }),
  })
  .strict();
export type GetChainFeesInput = z.infer<typeof GetChainFeesInputSchema>;

// objectItems(...) properties, none required at the item level.
export const GetChainFeesOutputSchema = ChainFeesArtifactSchema;
export type GetChainFeesOutput = z.infer<typeof GetChainFeesOutputSchema>;
