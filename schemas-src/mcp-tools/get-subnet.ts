// MCP tool `get_subnet` (types-epic E pilot batch, #7863). No REST mirror --
// the handler reads /metagraph/overview/{netuid}.json (a composed dashboard
// view: identity + health + profile + curation + gaps + counts), a DIFFERENT
// artifact from the `subnet-detail` REST route's raw
// /metagraph/subnets/{netuid}.json record (that one is what the separate
// get_subnet_detail tool mirrors, per ITS OWN description -- "Mirrors GET
// /api/v1/subnets/{netuid}").
//
// NOT a narrowing of SubnetDetailArtifactSchema, which is why this file cannot
// simply derive from it the way its siblings in #9796 do: the two share only 4
// of 15 keys. This is a different PROJECTION -- it flattens the route artifact's
// nested `subnet` object up to the top level and adds a composed health card.
//
// The six nested fields used to be bare `{type:"object"}` / `{type:"array"}`,
// left that way deliberately under #7863's wire-compatibility constraint:
// deep-typing them would have accepted LESS than the hand-written schema they
// replaced, which is a regression rather than an improvement.
//
// That constraint is satisfied here without keeping them opaque (#9797). Every
// nested shape below is `.passthrough()` and every field optional, so this
// accepts exactly what it accepted before -- nothing that validated stops
// validating. What changes is that an agent is now told what is in them, which
// on the tool most likely to be an agent's first call is the difference between
// a usable contract and none at all.
//
// `profile` and `gaps` reuse the route's own shapes rather than restating them,
// so those two cannot drift from the profile surface they come from. The rest
// are modelled from what production actually serves, verified field by field
// against a live get_subnet response.
import { z } from "zod";
import { SubnetProfileArtifactSchema } from "../routes/subnet-profiles.ts";
import { netuidSchema } from "./shared.ts";

export const GetSubnetInputSchema = z
  .object({
    netuid: netuidSchema(),
  })
  .strict();
export type GetSubnetInput = z.infer<typeof GetSubnetInputSchema>;

/** The composed health card. Probe-derived (#health): counts of surfaces by
 * verdict, the newest check, and the observed latency sample behind it. */
const SubnetOverviewHealthSchema = z
  .object({
    netuid: netuidSchema().optional(),
    name: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    surface_count: z.int().optional(),
    ok_count: z.int().optional(),
    degraded_count: z.int().optional(),
    failed_count: z.int().optional(),
    unknown_count: z.int().optional(),
    last_checked: z.string().nullable().optional(),
    last_ok: z.string().nullable().optional(),
    avg_latency_ms: z.number().nullable().optional(),
    latency_sample_count: z.int().nullable().optional(),
    observed_by: z.string().nullable().optional(),
  })
  .passthrough();

/** How many of each thing this subnet has registered. */
const SubnetOverviewCountsSchema = z
  .object({
    surfaces: z.int().optional(),
    endpoints: z.int().optional(),
    candidates: z.int().optional(),
  })
  .passthrough();

/** The human-governance axis: who reviewed this record and when. */
const SubnetOverviewCurationSchema = z
  .object({
    level: z.string().nullable().optional(),
    review_state: z.string().nullable().optional(),
    reviewed_at: z.string().nullable().optional(),
    verified_at: z.string().nullable().optional(),
    source_count: z.int().nullable().optional(),
    gap_notes: z.array(z.string()).optional(),
  })
  .passthrough();

/** One ranked enrichment opportunity. Was `z.array(z.unknown())`, which says
 * strictly less than an open object: not merely "shape unknown" but "nothing is
 * known about this value at all". */
const SubnetGapPrioritySchema = z
  .object({
    netuid: netuidSchema().optional(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    curation_level: z.string().nullable().optional(),
    candidate_count: z.int().optional(),
    missing_kinds: z.array(z.string()).optional(),
  })
  .passthrough();

export const GetSubnetOutputSchema = z
  .object({
    netuid: netuidSchema(),
    name: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    health: SubnetOverviewHealthSchema.nullable().optional(),
    // The profile surface's own shape, not a restatement of it.
    profile: SubnetProfileArtifactSchema.shape.profile.nullable().optional(),
    counts: SubnetOverviewCountsSchema.optional(),
    curation: SubnetOverviewCurationSchema.nullable().optional(),
    gaps: SubnetProfileArtifactSchema.shape.gaps.nullable().optional(),
    gap_priorities: z.array(SubnetGapPrioritySchema).optional(),
    operational_observed_at: z.string().nullable().optional(),
    health_source: z.string().nullable().optional(),
  })
  .passthrough();
export type GetSubnetOutput = z.infer<typeof GetSubnetOutputSchema>;
