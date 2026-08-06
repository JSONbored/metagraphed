// MCP tools `get_sudo`, `get_sudo_key`, `get_governance_config_changes`
// (types-epic E batch 8, #8071). Each mirrors a GET /api/v1/{sudo,governance}*
// route that is not one of schemas-src/routes/'s covered pilot routes -- no
// existing Zod schema to reuse. Modeled fresh, matching each hand-written
// literal field-for-field. get_sudo/get_governance_config_changes's input
// omits `required` entirely in the hand-written original (every field
// optional) rather than declaring `required: []` -- both are semantically
// identical JSON Schema and the diff-audit script already treats them as
// equal (see list_accounts/get_top_holders in #8070).
import { z } from "zod";
import {
  blockBoundSchema,
  keysetCursorSchema,
  limitSchema,
  offsetSchema,
} from "./shared.ts";
import { EXTRINSICS_LIMIT_MAX } from "./extrinsics.ts";
import { ExtrinsicItemSchema } from "./shared.ts";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetSudoInputSchema = z
  .object({
    block: z
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this exact block height.")
      .meta({ examples: [8783000] }),
    call_function: z
      .string()
      .optional()
      .describe(
        "Restrict to one call within the pallet (`add_stake`). Case-sensitive; pair with `call_module` to disambiguate.",
      )
      .meta({ examples: ["add_stake"] }),
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
    // Both feeds say "same filters as list_extrinsics" and were modelled on it,
    // but dropped its `.max(100)` — declaring unbounded while the tier they forward to
    // caps at 100. A copy-paste omission, not a wider ceiling.
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetSudoInput = z.infer<typeof GetSudoInputSchema>;

export const GetSudoOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type GetSudoOutput = z.infer<typeof GetSudoOutputSchema>;

export const GetSudoKeyInputSchema = z
  .object({
    // #8700: which chain to read. Absent means finney, so every existing
    // caller is unchanged. These routes answer from live storage whose keys
    // are chain-agnostic twox128 hashes — only the endpoint varies.
    network: McpNetworkSchema.optional(),
  })
  .strict();
export type GetSudoKeyInput = z.infer<typeof GetSudoKeyInputSchema>;

export const GetSudoKeyOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    hotkey: z.string().nullable(),
    queried_at: z.string().nullable(),
    // #9078 provenance, mirroring SudoKeyArtifactSchema field for field.
    field_sources: FieldSourcesSchema,
  })
  .passthrough();
export type GetSudoKeyOutput = z.infer<typeof GetSudoKeyOutputSchema>;

export const GetGovernanceConfigChangesInputSchema = z
  .object({
    block: z
      .int()
      .min(0)
      .optional()
      .describe("Restrict to this exact block height.")
      .meta({ examples: [8783000] }),
    call_function: z
      .string()
      .optional()
      .describe(
        "Restrict to one call within the pallet (`add_stake`). Case-sensitive; pair with `call_module` to disambiguate.",
      )
      .meta({ examples: ["add_stake"] }),
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
    // Both feeds say "same filters as list_extrinsics" and were modelled on it,
    // but dropped its `.max(100)` — declaring unbounded while the tier they forward to
    // caps at 100. A copy-paste omission, not a wider ceiling.
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: keysetCursorSchema().optional(),
  })
  .strict();
export type GetGovernanceConfigChangesInput = z.infer<
  typeof GetGovernanceConfigChangesInputSchema
>;

export const GetGovernanceConfigChangesOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    extrinsic_count: z.int(),
    limit: z.int().nullable().optional(),
    offset: z.int().nullable().optional(),
    next_cursor: z.string().nullable().optional(),
    extrinsics: z.array(ExtrinsicItemSchema),
  })
  .passthrough();
export type GetGovernanceConfigChangesOutput = z.infer<
  typeof GetGovernanceConfigChangesOutputSchema
>;
