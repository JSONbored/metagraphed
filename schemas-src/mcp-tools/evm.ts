// MCP tools `decode_evm_call`, `get_evm_address_mapping` (types-epic E
// batch 7, #8070). decode_evm_call is pure/local (src/evm-precompiles.ts,
// no REST mirror); get_evm_address_mapping mirrors GET /api/v1/evm/address/
// {h160}. Neither is one of schemas-src/routes/'s covered pilot routes --
// no existing Zod schema to reuse. Both hand-written originals declare
// their outputSchema INLINE on the tool definition (not via the shared
// TOOL_OUTPUT_SCHEMAS map every other tool in this epic uses) and are
// additionalProperties:false (strict) at the top level, unlike the
// additionalProperties:true posture everywhere else in this epic -- modeled
// here with the SAME strictness, not loosened to match the majority
// convention.
import { z } from "zod";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

const H160Schema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const DecodeEvmCallInputSchema = z
  .object({
    to: H160Schema.describe(
      "Inclusive end of the range. A block height on chain tools, an ISO-8601 date on time-series ones; an EVM address on decode_evm_call.",
    ),
    input: z
      .string()
      .regex(/^0x[0-9a-fA-F]*$/)
      .describe("ABI-encoded EVM call data (0x-prefixed) to decode."),
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
    ),
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

export const GetEvmAddressMappingOutputSchema = z
  .object({
    schema_version: z.int(),
    h160: z.string(),
    ss58: z.string().nullable(),
    queried_at: z.string().nullable(),
    // #9108 provenance, mirroring the REST artifact field for field.
    field_sources: FieldSourcesSchema,
  })
  .strict();
export type GetEvmAddressMappingOutput = z.infer<
  typeof GetEvmAddressMappingOutputSchema
>;
