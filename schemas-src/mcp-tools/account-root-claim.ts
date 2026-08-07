// MCP tool `get_account_root_claim`.
// Mirrors GET /api/v1/accounts/{ss58}/root-claim.
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
import { AccountRootClaimArtifactSchema } from "../routes/account-root-claim.ts";

export const GetAccountRootClaimInputSchema = z
  .object({
    ss58: ss58Schema(),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetAccountRootClaimInput = z.infer<
  typeof GetAccountRootClaimInputSchema
>;

export const GetAccountRootClaimOutputSchema = AccountRootClaimArtifactSchema;
export type GetAccountRootClaimOutput = z.infer<
  typeof GetAccountRootClaimOutputSchema
>;
