// MCP tools `get_sudo`, `get_sudo_key`, `get_governance_config_changes`.
// Mirror GET /api/v1/sudo, GET /api/v1/sudo/key, GET
// /api/v1/governance/config-changes.
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
import { EXTRINSICS_LIMIT_MAX } from "./extrinsics.ts";
import { McpNetworkSchema } from "../shared.ts";
import { ExtrinsicsFeedArtifactSchema } from "../routes/extrinsics.ts";
import { SudoKeyArtifactSchema } from "../routes/network-singletons.ts";

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

export const GetSudoOutputSchema = ExtrinsicsFeedArtifactSchema;
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

export const GetSudoKeyOutputSchema = SudoKeyArtifactSchema;
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

export const GetGovernanceConfigChangesOutputSchema =
  ExtrinsicsFeedArtifactSchema;
export type GetGovernanceConfigChangesOutput = z.infer<
  typeof GetGovernanceConfigChangesOutputSchema
>;
