// MCP tools `get_subnet_candidates`, `get_subnet_evidence`,
// `get_subnet_surfaces`.
// Mirror GET /api/v1/subnets/{netuid}/candidates, GET
// /api/v1/subnets/{netuid}/evidence, GET /api/v1/subnets/{netuid}/surfaces.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_subnet_candidates: 1 bare `{"type":"object"}` site.
//   get_subnet_evidence: 1 bare `{"type":"object"}` site.
//   get_subnet_surfaces: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  McpListPageFields,
  McpSubnetListArtifactStamp,
  fieldsStringSchema,
  kindSchema,
  limitSchema,
  netuidSchema,
  numericCursorSchema,
  orderSchema,
  projectableRows,
  providerSlugSchema,
  querySchema,
  sortSchema,
} from "./shared.ts";
import {
  SubnetCandidatesArtifactSchema,
  SubnetEvidenceArtifactSchema,
} from "../routes/candidates-evidence.ts";
import { SubnetSurfacesArtifactSchema } from "../routes/endpoints-pools.ts";
import {
  CANDIDATE_STATE_VALUES,
  SURFACE_KIND_VALUES,
} from "../routes/subnet-detail.ts";
import { CONFIDENCE_LEVEL_VALUES } from "../shared.ts";
import { CANDIDATE_SORT_VALUES, EVIDENCE_ENTRY_SORT_VALUES } from "./shared.ts";

const SURFACE_KINDS = SURFACE_KIND_VALUES;

export const GetSubnetCandidatesInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetCandidatesInput = z.infer<
  typeof GetSubnetCandidatesInputSchema
>;

export const GetSubnetCandidatesOutputSchema = SubnetCandidatesArtifactSchema;
export type GetSubnetCandidatesOutput = z.infer<
  typeof GetSubnetCandidatesOutputSchema
>;

const CANDIDATE_STATES = CANDIDATE_STATE_VALUES;
export const ListSubnetCandidatesInputSchema = z
  .object({
    netuid: netuidSchema(),
    kind: kindSchema(SURFACE_KINDS).optional(),
    provider: providerSlugSchema().optional(),
    state: z
      .enum(CANDIDATE_STATES)
      .optional()
      .describe("The incident's lifecycle state.")
      .meta({ examples: [CANDIDATE_STATES[0]] }),
    id: z
      .string()
      .optional()
      .describe(
        "The record's stable identifier, as returned by the corresponding list tool. Exact match; an unknown id yields an empty result rather than an error.",
      )
      .meta({ examples: ["sn-64-chutes-subnet-api"] }),
    confidence: z
      .enum(CONFIDENCE_LEVEL_VALUES)
      .optional()
      .describe("How confident the machine assessment is.")
      .meta({ examples: [CONFIDENCE_LEVEL_VALUES[0]] }),
    sort: sortSchema(CANDIDATE_SORT_VALUES).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetCandidatesInput = z.infer<
  typeof ListSubnetCandidatesInputSchema
>;

export const ListSubnetCandidatesOutputSchema =
  SubnetCandidatesArtifactSchema.pick({
    netuid: true,
    candidates: true,
  }).extend({
    candidates: projectableRows(
      SubnetCandidatesArtifactSchema.shape.candidates,
    ),
    ...McpSubnetListArtifactStamp,
    ...McpListPageFields,
  });
export type ListSubnetCandidatesOutput = z.infer<
  typeof ListSubnetCandidatesOutputSchema
>;

export const GetSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetEvidenceInput = z.infer<
  typeof GetSubnetEvidenceInputSchema
>;

export const GetSubnetEvidenceOutputSchema = SubnetEvidenceArtifactSchema;
export type GetSubnetEvidenceOutput = z.infer<
  typeof GetSubnetEvidenceOutputSchema
>;

export const ListSubnetEvidenceInputSchema = z
  .object({
    netuid: netuidSchema(),
    q: querySchema().optional(),
    sort: sortSchema(EVIDENCE_ENTRY_SORT_VALUES).optional(),
    order: orderSchema().optional(),
    fields: fieldsStringSchema().optional(),
    limit: limitSchema(100).optional(),
    cursor: numericCursorSchema().optional(),
  })
  .strict();
export type ListSubnetEvidenceInput = z.infer<
  typeof ListSubnetEvidenceInputSchema
>;

export const ListSubnetEvidenceOutputSchema = SubnetEvidenceArtifactSchema.pick(
  {
    netuid: true,
    claims: true,
  },
).extend({
  claims: projectableRows(SubnetEvidenceArtifactSchema.shape.claims),
  ...McpSubnetListArtifactStamp,
  ...McpListPageFields,
});
export type ListSubnetEvidenceOutput = z.infer<
  typeof ListSubnetEvidenceOutputSchema
>;

export const GetSubnetSurfacesInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetSurfacesInput = z.infer<
  typeof GetSubnetSurfacesInputSchema
>;

export const GetSubnetSurfacesOutputSchema = SubnetSurfacesArtifactSchema;
export type GetSubnetSurfacesOutput = z.infer<
  typeof GetSubnetSurfacesOutputSchema
>;
