// MCP tools `list_profiles`, `get_subnet_profile` (types-epic E batch 4,
// #8067). Mirror GET /api/v1/profiles and GET /api/v1/subnets/{netuid}/profile,
// neither of which is one of schemas-src/routes/'s covered pilot routes --
// no existing Zod schema to reuse (SubnetProfile from schemas-src/routes/
// subnet-profile.ts, #8055, is NOT reused: the hand-written LIST_PROFILES_
// OUTPUT_SCHEMA/GET_SUBNET_PROFILE_OUTPUT_SCHEMA this replaces already left
// `profiles`/`subnet`/`profile` as bare objects, not SubnetProfile-shaped --
// reusing the deep schema now would tighten what these two tools' own
// existing contract accepts, the same "look-but-don't-reuse" finding
// pilot batch's get-network-health.ts/get-economics.ts documented). Modeled
// fresh, shallow, from the hand-written literals src/profiles-mcp.ts
// replaces. Enum values hardcoded from src/contracts.ts's QUERY_ENUMS.{
// subnetType,curationLevel,profileLevel} and the "profiles" query
// collection's sort_fields at the time of writing.
import { z } from "zod";
import { OpenObjectArraySchema, OpenObjectSchema } from "./shared.ts";

const SUBNET_TYPE = ["root", "application"] as const;
const CURATION_LEVEL = [
  "native",
  "candidate-discovered",
  "community-seeded",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
] as const;
const PROFILE_LEVEL = [
  "directory-only",
  "identity-partial",
  "identity-complete",
  "operational",
  "adapter-backed",
] as const;
const PROFILES_SORT_FIELDS = [
  "candidate_count",
  "completeness_score",
  "curation_level",
  "interface_count",
  "missing_critical_count",
  "name",
  "netuid",
  "operational_interface_count",
  "profile_level",
  "review_state",
] as const;

export const ListProfilesInputSchema = z
  .object({
    netuid: z.int().min(0).optional(),
    subnet_type: z.enum(SUBNET_TYPE).optional(),
    curation_level: z.enum(CURATION_LEVEL).optional(),
    review_state: z.string().optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
    profile_level: z.enum(PROFILE_LEVEL).optional(),
    q: z.string().optional(),
    sort: z.enum(PROFILES_SORT_FIELDS).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    fields: z.string().optional(),
    limit: z.int().min(1).max(1000).optional(),
    cursor: z.int().min(0).optional(),
  })
  .strict();
export type ListProfilesInput = z.infer<typeof ListProfilesInputSchema>;

export const GetSubnetProfileInputSchema = z
  .object({
    netuid: z.int().min(0),
  })
  .strict();
export type GetSubnetProfileInput = z.infer<typeof GetSubnetProfileInputSchema>;

export const ListProfilesOutputSchema = z
  .object({
    captured_at: z.string().nullable().optional(),
    profiles: OpenObjectArraySchema,
    total: z.int().optional(),
    returned: z.int().optional(),
    limit: z.int().optional(),
    cursor: z.int().optional(),
    next_cursor: z.int().nullable().optional(),
    sort: z.string().nullable().optional(),
    order: z.string().nullable().optional(),
  })
  .passthrough();
export type ListProfilesOutput = z.infer<typeof ListProfilesOutputSchema>;

export const GetSubnetProfileOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    contract_version: z.string().nullable().optional(),
    generated_at: z.string().nullable().optional(),
    subnet: OpenObjectSchema.nullable().optional(),
    profile: OpenObjectSchema.nullable().optional(),
    surfaces: OpenObjectArraySchema.optional(),
    endpoints: OpenObjectArraySchema.optional(),
    gaps: OpenObjectSchema.nullable().optional(),
  })
  .passthrough();
export type GetSubnetProfileOutput = z.infer<
  typeof GetSubnetProfileOutputSchema
>;
