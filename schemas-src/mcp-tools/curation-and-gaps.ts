// MCP tools `list_curation`, `list_gaps` (types-epic E batch 11, #8074).
// Neither is defined inline in src/mcp-server.ts -- their `LIST_X_MCP_TOOL`/
// `LIST_X_OUTPUT_SCHEMA` hand-written literals live in src/curation-mcp.ts
// and src/gaps-mcp.ts respectively, imported into mcp-server.ts's MCP_TOOLS
// array via object spread. The z.toJSONSchema(...) wiring for these two
// happens in THEIR OWN files, not mcp-server.ts. Neither mirrors an existing
// schemas-src/routes/ REST schema -- modeled fresh, matching each
// hand-written literal field-for-field. Both declare `notes` as a PLAIN
// nullable string (unlike this batch's other list_* tools' array-or-string
// notes shape, see shared.ts's NotesFieldSchema) -- a genuine difference,
// preserved as-is.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

const COVERAGE_LEVELS = ["native-only", "manifested", "probed"] as const;
const CURATION_LEVELS = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const CURATION_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "name",
  "netuid",
] as const;

export const ListCurationInputSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    coverage_level: z.enum(COVERAGE_LEVELS).optional(),
    curation_level: z.enum(CURATION_LEVELS).optional(),
    sort: z.enum(CURATION_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListCurationInput = z.infer<typeof ListCurationInputSchema>;

export const ListCurationOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    curation: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListCurationOutput = z.infer<typeof ListCurationOutputSchema>;

const GAPS_SORT_FIELDS = [
  "coverage_level",
  "curation_level",
  "gap_count",
  "name",
  "netuid",
] as const;

export const ListGapsInputSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    coverage_level: z.enum(COVERAGE_LEVELS).optional(),
    curation_level: z.enum(CURATION_LEVELS).optional(),
    sort: z.enum(GAPS_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(100).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListGapsInput = z.infer<typeof ListGapsInputSchema>;

export const ListGapsOutputSchema = z
  .object({
    generated_at: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    gaps: z.array(OpenObjectSchema),
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListGapsOutput = z.infer<typeof ListGapsOutputSchema>;
