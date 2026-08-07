// MCP tools `get_account_parents`, `get_account_children`.
// Mirror GET /api/v1/accounts/{ss58}/parents, GET
// /api/v1/accounts/{ss58}/children.
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
import { ss58Schema } from "./shared.ts";
import { McpNetworkSchema } from "../shared.ts";
import {
  AccountChildrenArtifactSchema,
  AccountParentsArtifactSchema,
} from "../routes/account-child-delegation.ts";

export const GetAccountChildrenInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountChildrenInput = z.infer<
  typeof GetAccountChildrenInputSchema
>;

export const GetAccountChildrenOutputSchema = AccountChildrenArtifactSchema;
export type GetAccountChildrenOutput = z.infer<
  typeof GetAccountChildrenOutputSchema
>;

export const GetAccountParentsInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountParentsInput = z.infer<
  typeof GetAccountParentsInputSchema
>;

export const GetAccountParentsOutputSchema = AccountParentsArtifactSchema;
export type GetAccountParentsOutput = z.infer<
  typeof GetAccountParentsOutputSchema
>;
