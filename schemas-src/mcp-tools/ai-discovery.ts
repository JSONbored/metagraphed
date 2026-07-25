// MCP tools `find_subnet_opportunities`, `semantic_search`, `ask`,
// `find_subnet_for_task` (types-epic E batch 12, #8076). All four are
// defined inline in src/mcp-server.ts's MCP_TOOLS array. None mirror an
// existing schemas-src/routes/ REST schema -- modeled fresh, matching
// each hand-written literal field-for-field.
import { z } from "zod";
import { OpenObjectArraySchema } from "./shared.ts";

// Symbolic in the hand-written original (src/health-serving.ts's
// ECONOMIC_BOARD_SPECS[].key), cross-checked against the actual runtime
// source at the time of writing.
const ECONOMIC_LEADERBOARD_BOARDS = [
  "open-slots",
  "cheapest-registration",
  "highest-emission",
  "validator-headroom",
  "biggest-alpha-gain-1d",
  "biggest-alpha-gain-7d",
] as const;

// Symbolic in the hand-written original (src/ai-search.ts's SEMANTIC_TYPES),
// cross-checked against the actual runtime source at the time of writing.
// Shared by semantic_search and ask's `type` input field below (mirrors
// mcp-server.ts's own semanticTypeSchema() helper, used by both).
const SEMANTIC_TYPES = ["subnet", "surface", "provider"] as const;
const SemanticTypeSchema = z
  .union([z.enum(SEMANTIC_TYPES), z.array(z.enum(SEMANTIC_TYPES))])
  .optional();

export const FindSubnetOpportunitiesInputSchema = z
  .object({
    board: z.enum(ECONOMIC_LEADERBOARD_BOARDS).optional(),
    limit: z.int().min(1).max(100).optional(),
  })
  .strict();
export type FindSubnetOpportunitiesInput = z.infer<
  typeof FindSubnetOpportunitiesInputSchema
>;

const EconomicBoardEntrySchema = z
  .object({
    netuid: z.int().optional(),
    slug: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

export const FindSubnetOpportunitiesOutputSchema = z
  .object({
    board: z.string().nullable().optional(),
    observed_at: z.string().nullable().optional(),
    with_economics_count: z.int(),
    // Map of board key -> ranked subnet entries -- this epic's first use of
    // z.record(); its z.toJSONSchema() output always adds a `propertyNames:
    // {type:"string"}` sibling next to `additionalProperties`, a constraint
    // that's always true for a JSON object's keys and so never rejects
    // anything the hand-written original (bare `additionalProperties: {...}`,
    // no propertyNames) didn't already -- stripped by a new normalize() rule
    // in scripts/diff-mcp-tool-schemas.ts, the same treatment $schema/$id
    // already get.
    boards: z.record(z.string(), z.array(EconomicBoardEntrySchema)),
  })
  .passthrough();
export type FindSubnetOpportunitiesOutput = z.infer<
  typeof FindSubnetOpportunitiesOutputSchema
>;

export const SemanticSearchInputSchema = z
  .object({
    query: z.string(),
    limit: z.int().min(1).max(20).optional(),
    type: SemanticTypeSchema,
  })
  .strict();
export type SemanticSearchInput = z.infer<typeof SemanticSearchInputSchema>;

const SemanticSearchResultItemSchema = z
  .object({
    score: z.unknown().optional(),
    type: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    slug: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    subtitle: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

export const SemanticSearchOutputSchema = z
  .object({
    query: z.string(),
    count: z.int(),
    model: z.string().nullable().optional(),
    results: z.array(SemanticSearchResultItemSchema),
  })
  .passthrough();
export type SemanticSearchOutput = z.infer<typeof SemanticSearchOutputSchema>;

export const AskInputSchema = z
  .object({
    question: z.string(),
    type: SemanticTypeSchema,
  })
  .strict();
export type AskInput = z.infer<typeof AskInputSchema>;

const AskCitationItemSchema = z
  .object({
    ref: z.unknown().optional(),
    score: z.number().optional(),
    title: z.string().nullable().optional(),
    netuid: z.int().nullable().optional(),
    slug: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
  })
  .passthrough();

export const AskOutputSchema = z
  .object({
    question: z.string(),
    answer: z.string(),
    model: z.string().nullable().optional(),
    context_count: z.int().nullable().optional(),
    citations: z.array(AskCitationItemSchema).optional(),
  })
  .passthrough();
export type AskOutput = z.infer<typeof AskOutputSchema>;

export const FindSubnetForTaskInputSchema = z
  .object({
    task: z.string(),
    limit: z.int().min(1).max(20).optional(),
  })
  .strict();
export type FindSubnetForTaskInput = z.infer<
  typeof FindSubnetForTaskInputSchema
>;

// `discovery` is always set by the handler but, like `count` on several
// sibling AI tools in this batch, was never added to the hand-written
// original's `required` array -- preserved as-is.
export const FindSubnetForTaskOutputSchema = z
  .object({
    task: z.string(),
    count: z.int(),
    discovery: z.unknown().optional(),
    note: z.string().nullable().optional(),
    results: OpenObjectArraySchema,
  })
  .passthrough();
export type FindSubnetForTaskOutput = z.infer<
  typeof FindSubnetForTaskOutputSchema
>;
