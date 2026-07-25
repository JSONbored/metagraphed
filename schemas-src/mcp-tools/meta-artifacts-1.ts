// MCP tools `get_lineage`, `get_freshness`, `get_contracts`,
// `get_source_health` (types-epic E batch 12, #8075). `get_lineage` and
// `get_source_health` are defined inline in src/mcp-server.ts's MCP_TOOLS
// array; `get_freshness` is also inline but shares this file's grouping by
// shape; `get_contracts` lives in its own src/contracts-mcp.ts (its
// `GET_CONTRACTS_MCP_TOOL`/`GET_CONTRACTS_OUTPUT_SCHEMA` spread into
// mcp-server.ts's MCP_TOOLS array). All four are no-input, baked-artifact
// passthrough tools. None mirror an existing schemas-src/routes/ REST
// schema -- modeled fresh, matching each hand-written literal
// field-for-field.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- this
// batch's shared.ts predates the NotesFieldSchema helper hoisted in batch 10
// (#8074), still unmerged as of this batch (#8075) -- inlined here rather
// than depending on unmerged parallel work.
const NotesFieldSchema = z
  .union([z.array(z.string()), z.string()])
  .nullable()
  .optional();

export const GetLineageInputSchema = z.object({}).strict();
export type GetLineageInput = z.infer<typeof GetLineageInputSchema>;

export const GetLineageOutputSchema = z
  .object({
    link_count: z.int().optional(),
    graduated_subnet_count: z.int().optional(),
    broken_link_count: z.int().optional(),
    links: z.array(OpenObjectSchema).optional(),
    broken_links: z.array(OpenObjectSchema).optional(),
    generated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type GetLineageOutput = z.infer<typeof GetLineageOutputSchema>;

export const GetFreshnessInputSchema = z.object({}).strict();
export type GetFreshnessInput = z.infer<typeof GetFreshnessInputSchema>;

export const GetFreshnessOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    sources: z.array(OpenObjectSchema),
    summary: OpenObjectSchema.nullable().optional(),
    generated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type GetFreshnessOutput = z.infer<typeof GetFreshnessOutputSchema>;

export const GetContractsInputSchema = z.object({}).strict();
export type GetContractsInput = z.infer<typeof GetContractsInputSchema>;

export const GetContractsOutputSchema = z
  .object({
    schema_version: z.int(),
    contract_version: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    base_path: z.string().nullable().optional(),
    primary_domain: z.string().nullable().optional(),
    openapi_url: z.string().nullable().optional(),
    type_definitions_url: z.string().nullable().optional(),
    notes: NotesFieldSchema,
    artifacts: z.array(OpenObjectSchema),
  })
  .passthrough();
export type GetContractsOutput = z.infer<typeof GetContractsOutputSchema>;

export const GetSourceHealthInputSchema = z.object({}).strict();
export type GetSourceHealthInput = z.infer<typeof GetSourceHealthInputSchema>;

export const GetSourceHealthOutputSchema = z
  .object({
    providers: z.array(OpenObjectSchema),
    generated_at: z.string().nullable().optional(),
  })
  .passthrough();
export type GetSourceHealthOutput = z.infer<typeof GetSourceHealthOutputSchema>;
