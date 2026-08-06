// MCP tool `get_adapter` (types-epic E batch 12, #8075). Lives in its own
// src/adapters-mcp.ts (its `GET_ADAPTER_MCP_TOOL`/`GET_ADAPTER_OUTPUT_SCHEMA`
// spread into mcp-server.ts's MCP_TOOLS array). Does not mirror an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching the
// hand-written literal field-for-field.
import { z } from "zod";
import { OpenObjectSchema, netuidSchema } from "./shared.ts";

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
      .describe(
        "The registry slug — lowercase, hyphenated (`chutes`), not the display name. Slugs are stable across renames.",
      )
      .meta({ examples: ["chutes"] }),
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
    snapshot: OpenObjectSchema.nullable().optional(),
    extensions: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetAdapterOutput = z.infer<typeof GetAdapterOutputSchema>;
