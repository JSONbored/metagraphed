// MCP tool `get_subnet` (types-epic E pilot batch, #7863). No REST mirror --
// the handler reads /metagraph/overview/{netuid}.json (a composed dashboard
// view: identity + health + profile + curation + gaps + counts), a
// DIFFERENT artifact from the `subnet-detail` REST route's raw
// /metagraph/subnets/{netuid}.json record (that one is what the separate
// get_subnet_detail tool mirrors, per ITS OWN description -- "Mirrors GET
// /api/v1/subnets/{netuid}"). Nothing in schemas-src/routes/ models this
// composed-overview shape, so both schemas here are new, not reused.
// Nested object/array fields (health/profile/counts/curation/gaps/
// gap_priorities) were left shallow (bare `{type:"object"}` / `{type:"array"}`,
// no property-level constraints) in the hand-written schema this replaces --
// kept exactly that loose here too, per #7863's wire-compatibility
// constraint (deep-typing them would accept LESS than the original, a
// regression, not an improvement).
import { z } from "zod";

export const GetSubnetInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetInput = z.infer<typeof GetSubnetInputSchema>;

const OpenObjectSchema = z.object({}).passthrough();

export const GetSubnetOutputSchema = z
  .object({
    netuid: z.int(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    health: OpenObjectSchema.nullable().optional(),
    profile: OpenObjectSchema.nullable().optional(),
    counts: OpenObjectSchema.optional(),
    curation: OpenObjectSchema.nullable().optional(),
    gaps: OpenObjectSchema.nullable().optional(),
    gap_priorities: z.array(z.unknown()).optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type GetSubnetOutput = z.infer<typeof GetSubnetOutputSchema>;
