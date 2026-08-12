// MCP tools `get_lineage`, `get_freshness`, `get_contracts`,
// `get_source_health`.
// Mirror GET /api/v1/lineage, GET /api/v1/freshness, GET /api/v1/contracts, GET
// /api/v1/source-health.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_lineage: 2 bare `{"type":"object"}` sites.
//   get_freshness: 2 bare `{"type":"object"}` sites.
//   get_contracts: 1 bare `{"type":"object"}` site.
//   get_source_health: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  orderSchema,
  sortSchema,
  McpUnsortedPageFields,
  McpOffsetPageInput,
} from "./shared.ts";
import { API_QUERY_COLLECTIONS } from "../../src/contracts.ts";
import {
  FreshnessArtifactSchema,
  SourceHealthArtifactSchema,
} from "../routes/evidence-search.ts";
import { LineageArtifactSchema } from "../routes/lineage.ts";
import { ContractsArtifactSchema } from "../routes/meta-contracts.ts";

// `notes: {type:["array","string","null"], items:{type:"string"}}` -- this
// batch's shared.ts predates the NotesFieldSchema helper hoisted in batch 10
// (#8074), still unmerged as of this batch (#8075) -- inlined here rather
// than depending on unmerged parallel work.
export const GetLineageInputSchema = z.object({}).strict();
export type GetLineageInput = z.infer<typeof GetLineageInputSchema>;

export const GetLineageOutputSchema = LineageArtifactSchema;
export type GetLineageOutput = z.infer<typeof GetLineageOutputSchema>;

export const GetFreshnessInputSchema = z.object({}).strict();
export type GetFreshnessInput = z.infer<typeof GetFreshnessInputSchema>;

export const GetFreshnessOutputSchema = FreshnessArtifactSchema;
export type GetFreshnessOutput = z.infer<typeof GetFreshnessOutputSchema>;

export const GetContractsInputSchema = z
  .object({
    ...McpOffsetPageInput,
    sort: sortSchema(API_QUERY_COLLECTIONS.contracts.sort_fields).optional(),
    order: orderSchema().optional(),
  })
  .strict();
export type GetContractsInput = z.infer<typeof GetContractsInputSchema>;

export const GetContractsOutputSchema = ContractsArtifactSchema.extend({
  // The page block the MCP loader adds on top of the route's artifact --
  // undeclared until #10790, when `.strict()` first rejected it.
  ...McpUnsortedPageFields,
});
export type GetContractsOutput = z.infer<typeof GetContractsOutputSchema>;

export const GetSourceHealthInputSchema = z.object({}).strict();
export type GetSourceHealthInput = z.infer<typeof GetSourceHealthInputSchema>;

export const GetSourceHealthOutputSchema = SourceHealthArtifactSchema;
export type GetSourceHealthOutput = z.infer<typeof GetSourceHealthOutputSchema>;
