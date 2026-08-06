// MCP tool `get_domain_summary` (types-epic E batch 4, #8067). Composite
// tool mirroring EITHER GET /api/v1/domains/{tag}/summary (DomainSummaryArtifact
// shape) OR GET /api/v1/domains (DomainsArtifact shape), chosen by whether
// `domain` was passed -- schemas-src/routes/domains.ts (#8055) models each
// REST shape separately and strictly; this tool's single return value can be
// either one, so (matching the hand-written literal's own documented
// rationale) the output stays deliberately loose rather than reusing either
// REST schema or forcing a discriminated union that doesn't reflect how the
// original was ever validated. Modeled fresh, shallow, from the hand-written
// literal it replaces. Domain enum hardcoded from src/domain-tags.ts's
// DOMAIN_TAGS at the time of writing.
import { z } from "zod";
import { OpenObjectSchema } from "./shared.ts";

const DOMAIN_TAGS = [
  "agents",
  "compute",
  "data",
  "finance",
  "inference",
  "media",
  "prediction",
  "privacy",
  "robotics",
  "science",
  "search",
  "security",
  "storage",
  "training",
] as const;

export const GetDomainSummaryInputSchema = z
  .object({
    domain: z
      .enum(DOMAIN_TAGS)
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
    emission_concentration: OpenObjectSchema.nullable().optional(),
    domain_count: z.int().optional(),
    domains: z.array(OpenObjectSchema).optional(),
  })
  .passthrough();
export type GetDomainSummaryOutput = z.infer<
  typeof GetDomainSummaryOutputSchema
>;
