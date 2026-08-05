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
import { limitSchema, offsetSchema } from "./shared.ts";
import { EXTRINSICS_LIMIT_MAX } from "./extrinsics.ts";
import { ExtrinsicItemSchema } from "./shared.ts";
import { FieldSourcesSchema, McpNetworkSchema } from "../shared.ts";

export const GetSudoInputSchema = z
  .object({
    block: z.int().min(0).optional(),
    call_function: z.string().optional(),
    success: z.boolean().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    // #9460: both feeds say "same filters as list_extrinsics" and were modelled on it,
    // but dropped its `.max(100)` — declaring unbounded while the tier they forward to
    // caps at 100. A copy-paste omission, not a wider ceiling.
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: z.string().optional(),
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
    block: z.int().min(0).optional(),
    call_function: z.string().optional(),
    success: z.boolean().optional(),
    block_start: z.int().min(0).optional(),
    block_end: z.int().min(0).optional(),
    from: z.int().min(0).optional(),
    to: z.int().min(0).optional(),
    // #9460: both feeds say "same filters as list_extrinsics" and were modelled on it,
    // but dropped its `.max(100)` — declaring unbounded while the tier they forward to
    // caps at 100. A copy-paste omission, not a wider ceiling.
    limit: limitSchema(EXTRINSICS_LIMIT_MAX).optional(),
    offset: offsetSchema().optional(),
    cursor: z.string().optional(),
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
