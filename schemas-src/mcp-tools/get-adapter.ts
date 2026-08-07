// MCP tool `get_adapter` (types-epic E batch 12, #8075). Lives in its own
// src/adapters-mcp.ts (its `GET_ADAPTER_MCP_TOOL`/`GET_ADAPTER_OUTPUT_SCHEMA`
// spread into mcp-server.ts's MCP_TOOLS array). Does not mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching the
// hand-written literal field-for-field.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";
import { AdapterSnapshotSchema } from "../routes/adapter.ts";

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- this
// batch's shared.ts predates the NotesFieldSchema helper hoisted in batch 10
// (#8074), still unmerged as of this batch (#8075) -- inlined here rather
// than depending on unmerged parallel work.
const NotesFieldSchema = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional();

export const GetAdapterInputSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      // `gittensor` rather than `chutes` (#9860): there is no `chutes` adapter,
      // so the tool's own advertised example answered `not_found`. An example
      // is the first thing an agent copies, and one that does not work is worse
      // than none -- it teaches the wrong slug AND wastes the call.
      .describe(
        "The registry slug — lowercase, hyphenated (`gittensor`), not the display name. Slugs are stable across renames. Only subnets with a captured adapter snapshot have one; `list_subnets` is the way to find which.",
      )
      .meta({ examples: ["gittensor"] }),
  })
  .strict();
export type GetAdapterInput = z.infer<typeof GetAdapterInputSchema>;

export const GetAdapterOutputSchema = z
  .object({
    schema_version: z.int(),
    contract_version: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    slug: z.string(),
    subnet: z.string().nullable().optional(),
    netuid: netuidSchema().nullable().optional(),
    notes: NotesFieldSchema,
    // Typed from the route's own AdapterSnapshotSchema (#9797). Verified
    // against production 2026-08-07 (slug `gittensor`).
    snapshot: AdapterSnapshotSchema.nullable().optional(),
    extensions: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetAdapterOutput = z.infer<typeof GetAdapterOutputSchema>;
