// MCP tool `get_domain_summary` (types-epic E batch 4, #8067). Composite
// tool mirroring EITHER GET /api/v1/domains/{tag}/summary
// (DomainSummaryArtifact
// shape) OR GET /api/v1/domains (DomainsArtifact shape), chosen by whether
// `domain` was passed -- schemas-src/routes/domains.ts (#8055) models each
// REST shape separately and strictly; this tool's single return value can be
// either one, so (matching the hand-written literal's own documented
// rationale) the output stays deliberately loose rather than reusing either
// REST schema or forcing a discriminated union that doesn't reflect how the
// original was ever validated. Modeled fresh, shallow, from the hand-written
// literal it replaces.
//
// The domain enum is READ from src/domain-tags.ts rather than hardcoded. It
// used to be a local copy whose own comment said "at the time of writing" --
// a list that announced it could drift and had no way to be told when it did
// (#10131). That module is a zero-import leaf, the same shape as
// src/route-limits.ts, which this directory has read since #9127.
import { z } from "zod";
import { DOMAIN_TAGS } from "../../src/domain-tags.ts";
import {
  ConcentrationScorecardSchema,
  DomainSummaryArtifactSchema,
} from "../routes/domains.ts";

export const GetDomainSummaryInputSchema = z
  .object({
    domain: z
      .enum(DOMAIN_TAGS as [string, ...string[]])
      .optional()
      .describe("The subnet's primary domain of use.")
      .meta({ examples: [DOMAIN_TAGS[0]] }),
  })
  .strict();
export type GetDomainSummaryInput = z.infer<typeof GetDomainSummaryInputSchema>;

export const GetDomainSummaryOutputSchema = z
  .object({
    schema_version: z.int(),
    domain: z.string().nullable().optional(),
    subnet_count: z.int().optional(),
    netuids: z.array(z.int()).optional(),
    total_stake_tao: z.number().nullable().optional(),
    total_emission_share: z.number().nullable().optional(),
    // Typed from the route's own ConcentrationScorecardSchema (#9797).
    emission_concentration: ConcentrationScorecardSchema.nullable().optional(),
    domain_count: z.int().optional(),
    // The LIST form's key: calling without `domain` returns every domain's
    // summary, so each entry is a whole DomainSummaryArtifact. Optional
    // because a call WITH `domain` returns that one summary inline instead,
    // with no `domains` at all. Verified against production 2026-08-07 in
    // both forms.
    domains: z.array(DomainSummaryArtifactSchema).optional(),
  })
  .passthrough();
export type GetDomainSummaryOutput = z.infer<
  typeof GetDomainSummaryOutputSchema
>;
