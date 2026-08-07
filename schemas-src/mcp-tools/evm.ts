// MCP tool `get_evm_address_mapping`.
// Mirrors GET /api/v1/evm/address/{h160}.
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
import { McpNetworkSchema } from "../shared.ts";
import { EvmAddressMappingArtifactSchema } from "../routes/network-singletons.ts";

const H160Schema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const DecodeEvmCallInputSchema = z
  .object({
    // #9645 gave every `to` the shared range-bound sentence, which is right on
    // the fifteen tools where `to` IS a range bound and wrong here: this one is
    // the call's destination address. A shared name is not a shared meaning.
    to: H160Schema.describe(
      "The contract address the call is directed at: a 20-byte EVM address, " +
        "0x-prefixed, 40 hex characters. Not a range bound, despite the name " +
        "it shares with the block/date bounds on other tools.",
    ).meta({ examples: ["0x1234567890abcdef1234567890abcdef12345678"] }),
    input: z
      .string()
      .regex(/^0x[0-9a-fA-F]*$/)
      .describe("ABI-encoded EVM call data (0x-prefixed) to decode.")
      .meta({ examples: ["0xa9059cbb0000000000000000000000001234"] }),
  })
  .strict();
export type DecodeEvmCallInput = z.infer<typeof DecodeEvmCallInputSchema>;

export const DecodeEvmCallOutputSchema = z
  .object({
    precompile: z.string().nullable(),
    address: z.string().nullable(),
    function: z.string().nullable(),
    signature: z.string().optional(),
    args: z.object({}).passthrough().optional(),
  })
  .strict();
export type DecodeEvmCallOutput = z.infer<typeof DecodeEvmCallOutputSchema>;

export const GetEvmAddressMappingInputSchema = z
  .object({
    h160: H160Schema.describe(
      "A 20-byte EVM address (0x-prefixed, 40 hex characters) to resolve to its SS58 mirror.",
    ).meta({ examples: ["0x1234567890abcdef1234567890abcdef12345678"] }),
    // #8700: which chain to read. These routes answer from live storage, and
    // the storage keys are twox128 hashes of pallet+item names — identical on
    // every chain running the same runtime — so the endpoint is the only thing
    // that varies. Absent means finney, so every existing caller is unchanged.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetEvmAddressMappingInput = z.infer<
  typeof GetEvmAddressMappingInputSchema
>;

export const GetEvmAddressMappingOutputSchema = EvmAddressMappingArtifactSchema;
export type GetEvmAddressMappingOutput = z.infer<
  typeof GetEvmAddressMappingOutputSchema
>;
